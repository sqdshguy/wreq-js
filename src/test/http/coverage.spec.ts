import assert from "node:assert";
import { describe, test } from "node:test";
import {
  createSession,
  get,
  Headers,
  post,
  RequestError,
  Response,
  request,
  fetch as wreqFetch,
} from "../../wreq-js.js";
import { httpUrl } from "../helpers/http.js";

describe("Headers helpers", () => {
  test("normalizes, iterates, and deletes entries", () => {
    const init = [["X-Alpha", "one"], undefined as unknown as [string, string], ["X-Alpha", "two"]] as [
      string,
      string,
    ][];

    const headers = new Headers(init);
    headers.append("X-Bravo", "three");

    assert.strictEqual(headers.get("x-alpha"), "one, two");
    assert.strictEqual(headers.has("X-Bravo"), true);

    const keys = Array.from(headers.keys());
    const values = Array.from(headers.values());
    assert.ok(keys.includes("X-Alpha"));
    assert.ok(values.some((value) => value.includes("one")));

    const tuples = headers.toTuples();
    assert.ok(tuples.length >= 2);

    const obj = headers.toObject();
    assert.strictEqual(obj["X-Alpha"], "one, two");

    let count = 0;
    const context: { count: number } = { count: 0 };
    headers.forEach(function (this: { count: number }, value, name) {
      count += 1;
      this.count += value.length + name.length;
    }, context);

    assert.ok(count > 0);
    assert.ok(context.count > 0);

    headers.delete("X-Bravo");
    assert.strictEqual(headers.get("X-Bravo"), null);
  });

  test("validates header names and values", () => {
    const headers = new Headers();

    assert.throws(() => headers.set("", "value"), /Header name must not be empty/);
    assert.throws(() => headers.get(123 as unknown as string), /Header name must be a string/);
    assert.throws(() => headers.append("X-Null", null as unknown as string), /Header value must not be null/);
  });

  test("supports iterables and plain objects", () => {
    const fromMap = new Headers(new Map([["X-Map", "value"]]));
    assert.strictEqual(fromMap.get("x-map"), "value");

    const fromHeaders = new Headers(fromMap);
    assert.strictEqual(fromHeaders.get("X-Map"), "value");

    const fromObject = new Headers({
      "X-Defined": "ok",
      "X-Undefined": undefined,
      "X-Null": null,
    });
    assert.strictEqual(fromObject.get("X-Defined"), "ok");
    assert.strictEqual(fromObject.get("X-Undefined"), null);
  });
});

describe("Request helpers", () => {
  test("request/get/post helpers map options", async () => {
    await assert.rejects(
      async () => {
        await request({} as never);
      },
      (error: unknown) => error instanceof RequestError,
    );

    const response = await request({
      url: httpUrl("/get"),
      browser: "chrome_142",
      timeout: 10_000,
    });
    assert.strictEqual(response.status, 200);

    const getResponse = await get(httpUrl("/get"), { browser: "chrome_142", timeout: 10_000 });
    assert.strictEqual(getResponse.status, 200);

    const postResponse = await post(httpUrl("/get"), "payload", { browser: "chrome_142", timeout: 10_000 });
    assert.strictEqual(postResponse.status, 200);

    const legacySessionResponse = await request({
      url: httpUrl("/get"),
      browser: "chrome_142",
      sessionId: "legacy-session",
      cookieMode: "session",
      timeout: 10_000,
    });
    assert.strictEqual(legacySessionResponse.status, 200);
  });

  test("request() accepts signal/session/cookieMode fields", async () => {
    const controller = new AbortController();
    const session = await createSession({ browser: "chrome_142" });

    try {
      const signalResponse = await request({
        url: httpUrl("/get"),
        browser: "chrome_142",
        signal: controller.signal,
        timeout: 10_000,
      });
      assert.strictEqual(signalResponse.status, 200);

      await session.fetch(httpUrl("/cookies/set?token=legacy"), { timeout: 10_000 });

      const sessionResponse = await request({
        url: httpUrl("/cookies"),
        session,
        cookieMode: "session",
        timeout: 10_000,
      });
      const cookies = await sessionResponse.json<{ cookies: Record<string, string> }>();
      assert.strictEqual(cookies.cookies.token, "legacy");
    } finally {
      await session.close();
    }
  });

  test("accepts array, iterable, and object headers", async () => {
    const arrayResponse = await wreqFetch(httpUrl("/headers"), {
      browser: "chrome_142",
      timeout: 10_000,
      disableDefaultHeaders: true,
      headers: [
        ["X-Array", "one"],
        ["X-Array", "two"],
      ],
    });
    const arrayBody = await arrayResponse.json<{ headers: Record<string, string> }>();
    const arrayHeader = arrayBody.headers["X-Array"];
    assert.ok(arrayHeader?.includes("one"));

    const mapResponse = await wreqFetch(httpUrl("/headers"), {
      browser: "chrome_142",
      timeout: 10_000,
      disableDefaultHeaders: true,
      headers: new Map([["X-Map", "value"]]),
    });
    const mapBody = await mapResponse.json<{ headers: Record<string, string> }>();
    assert.strictEqual(mapBody.headers["X-Map"], "value");

    Object.defineProperty(Object.prototype, "X-Inherited", {
      value: "skip",
      enumerable: true,
      configurable: true,
    });

    try {
      const objectHeaders: Record<string, string | null> = {
        "X-Own": "ok",
        "X-Null": null,
      };

      const objectResponse = await wreqFetch(httpUrl("/headers"), {
        browser: "chrome_142",
        timeout: 10_000,
        disableDefaultHeaders: true,
        headers: objectHeaders,
      });
      const objectBody = await objectResponse.json<{ headers: Record<string, string> }>();
      const ownHeader = Object.entries(objectBody.headers).find(([name]) => name.toLowerCase() === "x-own");
      const inheritedHeader = Object.entries(objectBody.headers).find(([name]) => name.toLowerCase() === "x-inherited");
      assert.strictEqual(ownHeader?.[1], "ok");
      assert.strictEqual(inheritedHeader, undefined);

      const trimmedResponse = await wreqFetch(httpUrl("/headers"), {
        browser: "chrome_142",
        timeout: 10_000,
        disableDefaultHeaders: true,
        headers: {
          "  X-Trimmed  ": "yes",
        },
      });
      const trimmedBody = await trimmedResponse.json<{ headers: Record<string, string> }>();
      assert.strictEqual(trimmedBody.headers["X-Trimmed"], "yes");
    } finally {
      delete (Object.prototype as { [key: string]: unknown })["X-Inherited"];
    }
  });

  test("accepts Request objects and init overrides", async () => {
    const requestInput = new Request(httpUrl("/get"), {
      method: "POST",
      headers: {
        "X-From-Request": "yes",
      },
      body: "payload",
    });

    const response = await wreqFetch(requestInput, {
      browser: "chrome_142",
      timeout: 10_000,
      disableDefaultHeaders: true,
      headers: {
        "X-From-Init": "yes",
      },
    });

    const body = await response.json<{ method: string; headers: Record<string, string> }>();
    assert.strictEqual(body.method, "POST");
    assert.strictEqual(body.headers["X-From-Init"], "yes");
    assert.strictEqual(body.headers["X-From-Request"], undefined);
  });

  test("RequestError is also a TypeError for compatibility checks", () => {
    const error = new RequestError("boom");
    assert.ok(error instanceof RequestError);
    assert.ok(error instanceof TypeError);
  });
});

describe("Request validation", () => {
  test("normalizes methods and serializes body inputs", async () => {
    const whitespaceResponse = await wreqFetch(httpUrl("/get"), {
      method: "   ",
      browser: "chrome_142",
      timeout: 10_000,
    });
    const whitespaceBody = await whitespaceResponse.json<{ method: string }>();
    assert.strictEqual(whitespaceBody.method, "GET");

    const payloads = [
      "alpha",
      Buffer.from("bravo"),
      new URLSearchParams({ mode: "form" }),
      new ArrayBuffer(8),
      new Uint8Array([1, 2, 3]),
      new Blob(["charlie"], { type: "text/plain" }),
    ];

    for (const body of payloads) {
      const response = await wreqFetch(httpUrl("/get"), {
        method: "POST",
        browser: "chrome_142",
        timeout: 10_000,
        body,
      });
      assert.strictEqual(response.status, 200);
    }

    const formData = new FormData();
    formData.set("alpha", "one");
    const formResponse = await wreqFetch(httpUrl("/headers"), {
      method: "POST",
      browser: "chrome_142",
      timeout: 10_000,
      disableDefaultHeaders: true,
      body: formData,
    });
    const formBody = await formResponse.json<{ headers: Record<string, string> }>();
    assert.ok(formBody.headers["Content-Type"]?.startsWith("multipart/form-data;"));

    const blobResponse = await wreqFetch(httpUrl("/headers"), {
      method: "POST",
      browser: "chrome_142",
      timeout: 10_000,
      disableDefaultHeaders: true,
      body: new Blob(["delta"], { type: "text/plain" }),
    });
    const blobBody = await blobResponse.json<{ headers: Record<string, string> }>();
    assert.strictEqual(blobBody.headers["Content-Type"], "text/plain");
  });

  test("rejects invalid inputs", async () => {
    await assert.rejects(
      wreqFetch("   " as never, { browser: "chrome_142" }),
      (error: unknown) => error instanceof RequestError && /URL is required/.test(error.message),
    );

    await assert.rejects(
      wreqFetch(httpUrl("/get"), { browser: "chrome_142", redirect: "nope" as never }),
      (error: unknown) => error instanceof RequestError && /Redirect mode/.test(error.message),
    );

    await assert.rejects(
      wreqFetch(httpUrl("/get"), { browser: "invalid_browser" as never }),
      (error: unknown) => error instanceof RequestError && /Invalid browser profile/.test(error.message),
    );

    await assert.rejects(
      wreqFetch(httpUrl("/get"), { browser: "" as never }),
      (error: unknown) => error instanceof RequestError && /must not be empty/.test(error.message),
    );

    await assert.rejects(
      wreqFetch(httpUrl("/get"), { browser: "chrome_142", os: "plan9" as never }),
      (error: unknown) => error instanceof RequestError && /Invalid operating system/.test(error.message),
    );

    await assert.rejects(
      wreqFetch(httpUrl("/get"), { browser: "chrome_142", os: "" as never }),
      (error: unknown) => error instanceof RequestError && /must not be empty/.test(error.message),
    );

    await assert.rejects(
      wreqFetch(httpUrl("/get"), { browser: "chrome_142", timeout: Number.NaN }),
      (error: unknown) => error instanceof RequestError && /finite number/.test(error.message),
    );

    await assert.rejects(
      wreqFetch(httpUrl("/get"), { browser: "chrome_142", timeout: -1 }),
      (error: unknown) => error instanceof RequestError && /0 \(no timeout\) or a positive number/.test(error.message),
    );

    await assert.rejects(
      wreqFetch(httpUrl("/get"), { browser: "chrome_142", method: "GET", body: "nope" }),
      (error: unknown) => error instanceof RequestError && /cannot have a body/.test(error.message),
    );

    await assert.rejects(
      wreqFetch(httpUrl("/get"), { browser: "chrome_142", method: "HEAD", body: "nope" }),
      (error: unknown) => error instanceof RequestError && /cannot have a body/.test(error.message),
    );

    await assert.rejects(
      wreqFetch(httpUrl("/get"), { browser: "chrome_142", method: "POST", body: { nope: true } as never }),
      (error: unknown) => error instanceof TypeError && /Unsupported body type/.test(error.message),
    );

    await assert.rejects(
      wreqFetch(httpUrl("/get"), { browser: "chrome_142", headers: { "": "nope" } as never }),
      (error: unknown) => error instanceof TypeError && /Header name must not be empty/.test(error.message),
    );
  });
});

describe("Session validation", () => {
  test("captures defaults and closed state", async () => {
    const session = await createSession({
      sessionId: "coverage-session",
      browser: "chrome_142",
      proxy: "http://proxy.example.com:8080",
      timeout: 2500,
      insecure: true,
      trustStore: "defaultPaths",
    });

    try {
      const defaults = (session as unknown as { getDefaults: () => Record<string, unknown> }).getDefaults();
      assert.strictEqual(defaults.proxy, "http://proxy.example.com:8080");
      assert.strictEqual(defaults.timeout, 2500);
      assert.strictEqual(defaults.insecure, true);
      assert.strictEqual(defaults.trustStore, "defaultPaths");
      assert.strictEqual(session.closed, false);
    } finally {
      await session.close();
    }

    assert.strictEqual(session.closed, true);
    await session.close();
  });

  test("rejects invalid session/cookie combinations", async () => {
    const session = await createSession({ browser: "chrome_142" });

    try {
      await assert.rejects(
        wreqFetch(httpUrl("/get"), { browser: "chrome_142", session, sessionId: "abc" }),
        (error: unknown) =>
          error instanceof RequestError && /Provide either `session` or `sessionId`/.test(error.message),
      );
    } finally {
      await session.close();
    }

    await assert.rejects(
      wreqFetch(httpUrl("/get"), { browser: "chrome_142", session: {} as never }),
      (error: unknown) => error instanceof RequestError && /must be created via createSession/.test(error.message),
    );

    const closedSession = await createSession({ browser: "chrome_142" });
    await closedSession.close();

    await assert.rejects(
      wreqFetch(httpUrl("/get"), { browser: "chrome_142", session: closedSession }),
      (error: unknown) => error instanceof RequestError && /Session has been closed/.test(error.message),
    );

    await assert.rejects(
      wreqFetch(httpUrl("/get"), { browser: "chrome_142", cookieMode: "session" }),
      (error: unknown) => error instanceof RequestError && /requires a session or sessionId/.test(error.message),
    );

    await assert.rejects(
      wreqFetch(httpUrl("/get"), { browser: "chrome_142", sessionId: "abc", cookieMode: "ephemeral" }),
      (error: unknown) => error instanceof RequestError && /cannot be combined/.test(error.message),
    );

    const response = await wreqFetch(httpUrl("/get"), {
      browser: "chrome_142",
      timeout: 10_000,
      sessionId: "abc",
      cookieMode: "session",
    });
    assert.strictEqual(response.status, 200);
  });

  test("rejects invalid session overrides and applies options", async () => {
    const session = await createSession({ browser: "chrome_142" });

    try {
      await assert.rejects(
        session.fetch(httpUrl("/get"), { sessionId: "abc" } as never),
        (error: unknown) =>
          error instanceof RequestError && /Provide either `session` or `sessionId`/.test(error.message),
      );

      await assert.rejects(
        session.fetch(httpUrl("/get"), { browser: "firefox_139" as never }),
        (error: unknown) => error instanceof RequestError && /Session browser cannot be changed/.test(error.message),
      );

      await assert.rejects(
        session.fetch(httpUrl("/get"), { os: "linux" as never }),
        (error: unknown) =>
          error instanceof RequestError && /Session operating system cannot be changed/.test(error.message),
      );

      await assert.rejects(
        session.fetch(httpUrl("/get"), { timeout: -1 }),
        (error: unknown) =>
          error instanceof RequestError && /0 \(no timeout\) or a positive number/.test(error.message),
      );

      const response = await session.fetch(httpUrl("/headers"), {
        headers: { "X-Session": "ok" },
        timeout: 10_000,
      });
      const body = await response.json<{ headers: Record<string, string> }>();
      assert.strictEqual(body.headers["X-Session"], "ok");
    } finally {
      await session.close();
    }
  });
});

describe("Response helpers", () => {
  const makePayload = (overrides?: Partial<Record<string, unknown>>) => ({
    status: 200,
    headers: ["X-Test", "alpha"],
    bodyHandle: null,
    bodyBytes: null,
    contentLength: null,
    url: "http://example.com/final",
    ...overrides,
  });

  test("memoizes redirect status and handles invalid URLs", () => {
    const response = new Response(
      makePayload({ url: "http://example.com/after" }) as never,
      "http://example.com/before",
    );

    assert.strictEqual(response.redirected, true);
    assert.strictEqual(response.redirected, true);

    const invalid = new Response(makePayload({ url: "http://example.com/after" }) as never, "not-a-url");
    assert.strictEqual(invalid.redirected, true);
  });

  test("exposes status text, headers, and cookies", () => {
    const response = new Response(
      makePayload({
        status: 200,
        headers: ["X-Test", "alpha"],
        cookies: ["session", "one", "session", "two"],
      }) as never,
      "http://example.com/final",
    );

    assert.strictEqual(response.statusText, "OK");
    assert.strictEqual(response.headers.get("x-test"), "alpha");

    const cookies = response.cookies;
    assert.deepStrictEqual(cookies.session, ["one", "two"]);

    const unknown = new Response(makePayload({ status: 599 }) as never, "http://example.com/final");
    assert.strictEqual(unknown.statusText, "");
  });

  test("handles inline bodies, streams, and clone safety", async () => {
    const inline = new Response(
      makePayload({ bodyBytes: Buffer.from("hello"), contentLength: 5 }) as never,
      "http://example.com/final",
    );

    assert.strictEqual(await inline.text(), "hello");
    await assert.rejects(
      inline.text(),
      (error: unknown) => error instanceof TypeError && /already used/.test(error.message),
    );

    const used = new Response(makePayload({ bodyBytes: Buffer.from("used") }) as never, "http://example.com/final");
    await used.text();
    assert.throws(() => used.clone(), /already used/);

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("streamed"));
        controller.close();
      },
    });

    const streamed = new Response(makePayload() as never, "http://example.com/final", stream);
    const clone = streamed.clone();
    const [originalText, cloneText] = await Promise.all([streamed.text(), clone.text()]);

    assert.strictEqual(originalText, "streamed");
    assert.strictEqual(cloneText, "streamed");

    const empty = new Response(makePayload({ bodyBytes: null, bodyHandle: null }) as never, "http://example.com/final");
    assert.strictEqual(empty.body, null);
  });

  test("supports blob and formData helpers", async () => {
    const blobResponse = new Response(
      makePayload({
        headers: ["Content-Type", "text/plain"],
        bodyBytes: Buffer.from("blob-text"),
      }) as never,
      "http://example.com/final",
    );
    const blob = await blobResponse.blob();
    assert.strictEqual(blob.type, "text/plain");
    assert.strictEqual(await blob.text(), "blob-text");

    const formResponse = new Response(
      makePayload({
        headers: ["Content-Type", "application/x-www-form-urlencoded;charset=UTF-8"],
        bodyBytes: Buffer.from("alpha=one&beta=two"),
      }) as never,
      "http://example.com/final",
    );
    const formData = await formResponse.formData();
    assert.strictEqual(formData.get("alpha"), "one");
    assert.strictEqual(formData.get("beta"), "two");
  });

  test("allows clone after body access before consumption", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("clone-late"));
        controller.close();
      },
    });

    const response = new Response(makePayload() as never, "http://example.com/final", stream);
    assert.ok(response.body, "body should be accessible");

    const clone = response.clone();
    const [left, right] = await Promise.all([response.text(), clone.text()]);
    assert.strictEqual(left, "clone-late");
    assert.strictEqual(right, "clone-late");
  });
});
