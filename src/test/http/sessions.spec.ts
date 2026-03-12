import assert from "node:assert";
import { describe, test } from "node:test";
import type { Session } from "../../wreq-js.js";
import { createSession, RequestError, withSession, fetch as wreqFetch } from "../../wreq-js.js";
import { httpUrl } from "../helpers/http.js";

describe("HTTP sessions", () => {
  test("setCookie/getCookies round-trips and affects outgoing requests", async () => {
    const session = await createSession({ browser: "chrome_142" });
    const cookiesUrl = httpUrl("/cookies");

    try {
      assert.deepStrictEqual(session.getCookies(cookiesUrl), {}, "New sessions should start with an empty cookie jar");

      session.setCookie("token", "abc123", cookiesUrl);

      assert.deepStrictEqual(session.getCookies(cookiesUrl), { token: "abc123" });

      const response = await session.fetch(cookiesUrl, { timeout: 10_000 });
      const body = await response.json<{ cookies: Record<string, string> }>();
      assert.strictEqual(body.cookies.token, "abc123");
    } finally {
      await session.close();
    }
  });

  test("recreating a disposed session id starts with an empty cookie jar", async () => {
    const sessionId = `cookie-disposed-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const cookiesUrl = httpUrl("/cookies");

    const first = await createSession({ browser: "chrome_142", sessionId });
    try {
      first.setCookie("persist", "nope", cookiesUrl);
      assert.deepStrictEqual(first.getCookies(cookiesUrl), { persist: "nope" });
    } finally {
      await first.close();
    }

    const second = await createSession({ browser: "chrome_142", sessionId });
    try {
      assert.deepStrictEqual(second.getCookies(cookiesUrl), {}, "Dropped session ids should not retain cookies");
    } finally {
      await second.close();
    }
  });

  test("rejects invalid setCookie input and keeps jar unchanged", async () => {
    const session = await createSession({ browser: "chrome_142" });
    const cookiesUrl = httpUrl("/cookies");

    try {
      assert.deepStrictEqual(session.getCookies(cookiesUrl), {});

      assert.throws(
        () => {
          session.setCookie("", "value", cookiesUrl);
        },
        (error: unknown) => error instanceof RequestError && /Invalid cookie string/.test(error.message),
      );

      assert.deepStrictEqual(session.getCookies(cookiesUrl), {}, "Invalid setCookie input should not mutate the jar");
    } finally {
      await session.close();
    }
  });

  test("rejects cookie APIs on disposed sessions", async () => {
    const session = await createSession({ browser: "chrome_142" });
    await session.close();

    assert.throws(
      () => {
        session.getCookies(httpUrl("/cookies"));
      },
      (error: unknown) => error instanceof RequestError && /Session has been closed/.test(error.message),
    );

    assert.throws(
      () => {
        session.setCookie("k", "v", httpUrl("/cookies"));
      },
      (error: unknown) => error instanceof RequestError && /Session has been closed/.test(error.message),
    );
  });

  test("isolates cookies for default fetch calls", async () => {
    await wreqFetch(httpUrl("/cookies/set?ephemeral=on"), {
      browser: "chrome_142",
      timeout: 5000,
    });

    const response = await wreqFetch(httpUrl("/cookies"), {
      browser: "chrome_142",
      timeout: 5000,
    });

    const body = await response.json<{ cookies: Record<string, string> }>();

    assert.ok(!body.cookies.ephemeral, "Ephemeral cookies should not persist across requests");
  });

  test("isolates cookies between sessions", async () => {
    const sessionA = await createSession({ browser: "chrome_142" });
    const sessionB = await createSession({ browser: "chrome_142" });

    try {
      await sessionA.fetch(httpUrl("/cookies/set?flavor=alpha"), { timeout: 10000 });
      await sessionB.fetch(httpUrl("/cookies/set?flavor=beta"), { timeout: 10000 });

      const cookiesA = await sessionA.fetch(httpUrl("/cookies"), { timeout: 10000 });
      const cookiesB = await sessionB.fetch(httpUrl("/cookies"), { timeout: 10000 });

      const bodyA = await cookiesA.json<{ cookies: Record<string, string> }>();
      const bodyB = await cookiesB.json<{ cookies: Record<string, string> }>();

      assert.strictEqual(bodyA.cookies.flavor, "alpha", "Session A should keep its own cookies");
      assert.strictEqual(bodyB.cookies.flavor, "beta", "Session B should keep its own cookies");
    } finally {
      await sessionA.close();
      await sessionB.close();
    }
  });

  test("clears session cookies on demand", async () => {
    const session = await createSession({ browser: "chrome_142" });

    try {
      await session.fetch(httpUrl("/cookies/set?token=123"), { timeout: 10000 });
      await session.clearCookies();

      const response = await session.fetch(httpUrl("/cookies"), { timeout: 10000 });
      const body = await response.json<{ cookies: Record<string, string> }>();

      assert.deepStrictEqual(body.cookies, {}, "Clearing the session should drop stored cookies");
    } finally {
      await session.close();
    }
  });

  test("withSession helper disposes sessions automatically", async () => {
    let capturedSession: Session | undefined;

    await withSession(async (session: Session) => {
      capturedSession = session;
      const response = await session.fetch(httpUrl("/get"), { timeout: 5000 });
      assert.strictEqual(response.status, 200);
    });

    const session = capturedSession;
    assert.ok(session, "withSession should provide a session instance");

    await assert.rejects(
      async () => {
        await session.fetch(httpUrl("/get"), { timeout: 5000 });
      },
      (error: unknown) => error instanceof RequestError,
      "Using a closed session should fail",
    );
  });

  test("rejects changing session proxy per request", async () => {
    const session = await createSession({ browser: "chrome_142" });

    try {
      await assert.rejects(
        session.fetch(httpUrl("/get"), { proxy: "http://proxy.example.com:8080", timeout: 5_000 }),
        (error: unknown) => error instanceof RequestError && /Session proxy cannot be changed/.test(error.message),
      );
    } finally {
      await session.close();
    }
  });

  test("createSession({ emulation }) works without browser/os and reuses standalone custom emulation", async () => {
    const session = await createSession({
      emulation: {
        headers: {
          "User-Agent": "Standalone Session/1.0",
          "X-Session-Emulation": "alpha",
        },
      },
    });

    try {
      const first = await session.fetch(httpUrl("/headers"), { timeout: 10_000 });
      const second = await session.fetch(httpUrl("/headers"), { timeout: 10_000 });

      const firstBody = await first.json<{ headers: Record<string, string> }>();
      const secondBody = await second.json<{ headers: Record<string, string> }>();

      assert.strictEqual(firstBody.headers["User-Agent"], "Standalone Session/1.0");
      assert.strictEqual(firstBody.headers["X-Session-Emulation"], "alpha");
      assert.strictEqual(secondBody.headers["User-Agent"], "Standalone Session/1.0");
      assert.strictEqual(secondBody.headers["X-Session-Emulation"], "alpha");
    } finally {
      await session.close();
    }
  });
});
