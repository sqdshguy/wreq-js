import assert from "node:assert";
import { describe, test } from "node:test";
import { setImmediate as nextTick } from "node:timers/promises";
import { createSession, fetch as wreqFetch } from "../../wreq-js.js";
import { httpUrl, isLocalHttpBase } from "../helpers/http.js";

const forceGc = (globalThis as { gc?: () => void }).gc;

// The string-id request path reads the same native jar as the Session object, without
// keeping a JS reference to it, so it can observe whether the jar still exists.
async function cookiesViaStringId(sessionId: string): Promise<Record<string, string>> {
  const response = await wreqFetch(httpUrl("/cookies"), { sessionId, cookieMode: "session", timeout: 10_000 });
  const body = await response.json<{ cookies: Record<string, string> }>();
  return body.cookies;
}

describe("session lifetime", () => {
  test("a session keeps its cookie jar for as long as it is open", { skip: !isLocalHttpBase }, async () => {
    const session = await createSession({ sessionId: `keep-${Date.now()}-${Math.random().toString(16).slice(2)}` });
    try {
      session.setCookie("token", "abc123", httpUrl("/cookies"));
      assert.deepStrictEqual(await cookiesViaStringId(session.id), { token: "abc123" });
      assert.deepStrictEqual(session.getCookies(httpUrl("/cookies")), { token: "abc123" });
    } finally {
      await session.close();
    }
  });

  test("close() releases the native jar", { skip: !isLocalHttpBase }, async () => {
    const session = await createSession({ sessionId: `close-${Date.now()}-${Math.random().toString(16).slice(2)}` });
    session.setCookie("token", "abc123", httpUrl("/cookies"));
    await session.close();

    assert.deepStrictEqual(await cookiesViaStringId(session.id), {}, "a closed session's cookies must be gone");
  });

  test("an unreferenced Session releases its native jar when garbage collected", {
    skip: !isLocalHttpBase || typeof forceGc !== "function",
  }, async () => {
    const sessionId = `gc-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    // Scope the Session so nothing holds it once this function returns.
    await (async () => {
      const session = await createSession({ sessionId });
      session.setCookie("token", "abc123", httpUrl("/cookies"));
    })();

    assert.deepStrictEqual(await cookiesViaStringId(sessionId), { token: "abc123" });

    let released = false;
    for (let attempt = 0; attempt < 50 && !released; attempt += 1) {
      forceGc?.();
      await nextTick();
      await nextTick();
      released = Object.keys(await cookiesViaStringId(sessionId)).length === 0;
    }

    assert.ok(released, "the finalizer should have dropped the jar after the Session was collected");
  });
});
