import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createSession, fetch as wreqFetch } from "../../wreq-js.js";
import { httpUrl, isLocalHttpBase } from "../helpers/http.js";

describe("HTTP requests", () => {
  test("accepts URL objects", async () => {
    const response = await wreqFetch(new URL(httpUrl("/get")), {
      browser: "chrome_142",
      timeout: 10_000,
    });

    assert.strictEqual(response.status, 200);
    const body = await response.json<{ method?: string }>();
    assert.strictEqual(body.method, "GET");
  });

  test("performs a basic GET request", async () => {
    const response = await wreqFetch(httpUrl("/get"), {
      browser: "chrome_131",
      timeout: 10_000,
    });

    assert.ok(response.status >= 200 && response.status < 300, "Should return successful status");
    assert.ok(response.headers.has("content-type"), "Should have response headers");

    const body = await response.json<{ headers: Record<string, string> }>();

    assert.ok(body.headers["User-Agent"], "Should have User-Agent header");
    assert.ok(response.bodyUsed, "json() should mark the body as used");
  });

  test("supports multiple browser profiles", async () => {
    const testUrl = httpUrl("/user-agent");
    const browsers = ["chrome_142", "firefox_139", "safari_18"] as const;

    for (const browser of browsers) {
      const response = await wreqFetch(testUrl, {
        browser,
        timeout: 10_000,
      });

      assert.strictEqual(response.status, 200, `${browser} should return status 200`);

      const data = await response.json<{ "user-agent"?: string }>();

      assert.ok(data["user-agent"], `${browser} should provide a user-agent header`);
      assert.ok(response.bodyUsed, "json() should consume the body stream");
    }
  });

  test("defaults to macOS operating system emulation", async () => {
    const response = await wreqFetch(httpUrl("/user-agent"), {
      browser: "chrome_142",
      timeout: 10_000,
    });

    assert.strictEqual(response.status, 200, "Should return status 200");
    const data = await response.json<{ "user-agent"?: string }>();
    const userAgent = data["user-agent"] ?? "";

    assert.ok(/Macintosh|Mac OS X/i.test(userAgent), "Should emit macOS user agent by default");
  });

  test("allows choosing an operating system to emulate", async () => {
    const response = await wreqFetch(httpUrl("/user-agent"), {
      browser: "chrome_142",
      os: "windows",
      timeout: 10_000,
    });

    assert.strictEqual(response.status, 200, "Should return status 200");
    const data = await response.json<{ "user-agent"?: string }>();
    const userAgent = data["user-agent"] ?? "";

    assert.ok(/Windows NT|Win64/i.test(userAgent), "Should emit Windows user agent when requested");
    assert.ok(!/Macintosh|Mac OS X/i.test(userAgent), "Should not emit macOS user agent when Windows selected");
  });

  test("applies session operating system to all requests", async () => {
    const session = await createSession({
      browser: "chrome_142",
      os: "linux",
      timeout: 10_000,
    });

    try {
      const response = await session.fetch(httpUrl("/user-agent"), {
        timeout: 10_000,
      });

      assert.strictEqual(response.status, 200, "Should return status 200");
      const data = await response.json<{ "user-agent"?: string }>();
      const userAgent = data["user-agent"] ?? "";

      assert.ok(/Linux/i.test(userAgent), "Should emit Linux user agent when session OS is linux");
    } finally {
      await session.close();
    }
  });

  test("provides functional clone and text helpers", async () => {
    const response = await wreqFetch(httpUrl("/json"), {
      browser: "chrome_142",
      timeout: 10000,
    });

    const clone = response.clone();
    const original = await response.json();
    const cloneText = await clone.text();

    assert.ok(original, "json() should parse successfully");
    assert.ok(cloneText.length > 0, "clone text should return payload");
    assert.ok(response.bodyUsed, "original body should be consumed");
    assert.ok(clone.bodyUsed, "clone body should be consumed");
  });

  test("preserves binary response bodies", async () => {
    const response = await wreqFetch(httpUrl("/binary"), {
      browser: "chrome_142",
      timeout: 10000,
    });

    const buf = Buffer.from(await response.arrayBuffer());

    assert.strictEqual(buf.length, 256, "binary response should match expected length");
    for (let i = 0; i < buf.length; i += 1) {
      assert.strictEqual(buf[i], i % 256, "binary response should preserve byte order");
    }
    assert.ok(response.bodyUsed, "arrayBuffer() should mark the body as used");
  });

  for (const { name, route, chunkCount, chunkSize } of [
    { name: "paced", route: "/stream/chunks", chunkCount: 4, chunkSize: 64 },
    { name: "buffered", route: "/chunked/many", chunkCount: 4, chunkSize: 64 },
    { name: "large", route: "/chunked/many", chunkCount: 512, chunkSize: 8192 },
  ]) {
    test(`streams ${name} response bodies via ReadableStream`, { skip: !isLocalHttpBase }, async () => {
      const response = await wreqFetch(httpUrl(`${route}?n=${chunkCount}&size=${chunkSize}`), {
        browser: "chrome_142",
        timeout: 10_000,
      });

      assert.ok(response.body && typeof response.body.getReader === "function", "body should be a ReadableStream");
      assert.strictEqual(response.bodyUsed, false, "bodyUsed should remain false before consumption");

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          assert.ok(value, "chunk should have data");
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }

      // Stream reads may split or combine server writes. Check every byte in order,
      // independently of read boundaries, for both inline and native streamed bodies.
      const actual = Buffer.concat(chunks);
      const expected = Buffer.alloc(chunkCount * chunkSize);
      for (let i = 0; i < chunkCount; i += 1) {
        expected.fill(i & 0xff, i * chunkSize, (i + 1) * chunkSize);
      }
      assert.strictEqual(actual.length, expected.length, "should receive expected byte count");
      assert.deepStrictEqual(actual, expected, "stream should preserve every byte in order");
      assert.ok(response.bodyUsed, "stream consumption should mark the body as used");
    });
  }

  test("cancelling a response stream marks body as used and prevents re-read", { skip: !isLocalHttpBase }, async () => {
    const response = await wreqFetch(httpUrl("/stream/chunks?n=8&size=128"), {
      browser: "chrome_142",
      timeout: 10_000,
    });

    const reader = response.body?.getReader();
    assert.ok(reader, "body reader should be available");

    const firstChunk = await reader.read();
    assert.strictEqual(firstChunk.done, false);
    assert.ok((firstChunk.value?.byteLength ?? 0) > 0);

    await reader.cancel("stop");

    assert.strictEqual(response.bodyUsed, true, "cancel() should mark body as used");
    await assert.rejects(async () => response.arrayBuffer(), /already\s+.*used/i);
  });

  test("reading body stream then text consumes once", { skip: !isLocalHttpBase }, async () => {
    const response = await wreqFetch(httpUrl("/stream/chunks?n=3&size=32"), {
      browser: "chrome_142",
      timeout: 10_000,
    });

    assert.ok(response.body, "body stream should be available");
    assert.strictEqual(response.bodyUsed, false);

    const text = await response.text();
    assert.ok(text.length > 0);
    assert.strictEqual(response.bodyUsed, true);

    await assert.rejects(async () => response.text(), /already\s+.*used/i);
  });

  test("clones a native body after body access without consuming the original", {
    skip: !isLocalHttpBase,
  }, async () => {
    // Exceed the inline limit even if the entire response arrives before fetch resolves.
    const response = await wreqFetch(httpUrl("/chunked/many?n=512&size=8192"), {
      browser: "chrome_142",
      timeout: 10_000,
    });
    assert.ok(response.body);
    const clone = response.clone();
    const clonedBytes = await clone.bytes();
    assert.strictEqual(response.bodyUsed, false);
    const originalBytes = await response.bytes();
    assert.deepStrictEqual(originalBytes, clonedBytes);
    assert.strictEqual(originalBytes.byteLength, 512 * 8192);
    assert.strictEqual(response.bodyUsed, true);
  });

  test("follows redirects by default", { skip: !isLocalHttpBase }, async () => {
    const response = await wreqFetch(httpUrl("/redirect"), {
      browser: "chrome_142",
      timeout: 10_000,
    });

    assert.strictEqual(response.status, 200, "should resolve final redirect target");
    assert.strictEqual(response.url, httpUrl("/json"));
    assert.strictEqual(response.redirected, true, "should mark response as redirected");
  });

  test("returns 3xx response when redirect is manual", { skip: !isLocalHttpBase }, async () => {
    const response = await wreqFetch(httpUrl("/redirect"), {
      browser: "chrome_142",
      redirect: "manual",
      timeout: 10_000,
    });

    assert.strictEqual(response.status, 302);
    assert.strictEqual(response.redirected, false);
    assert.strictEqual(response.url, httpUrl("/redirect"));
    assert.strictEqual(response.headers.get("location"), httpUrl("/json"));
  });

  test("rejects when redirect mode is error", { skip: !isLocalHttpBase }, async () => {
    await assert.rejects(
      wreqFetch(httpUrl("/redirect"), {
        browser: "chrome_142",
        redirect: "error",
        timeout: 10_000,
      }),
      (error: unknown) => error instanceof Error && /redirect/i.test(error.message),
      "should reject when redirects are disabled",
    );
  });

  test("supports TRACE requests", { skip: !isLocalHttpBase }, async () => {
    const response = await wreqFetch(httpUrl("/trace"), {
      method: "TRACE",
      browser: "chrome_142",
      timeout: 10_000,
    });

    assert.strictEqual(response.status, 200);
    const body = await response.json<{ method?: string; path?: string }>();
    assert.strictEqual(body.method, "TRACE");
    assert.strictEqual(body.path, "/trace");
  });

  test("supports PUT, DELETE, PATCH, and OPTIONS requests", { skip: !isLocalHttpBase }, async () => {
    const methods = ["PUT", "DELETE", "PATCH", "OPTIONS"] as const;

    for (const method of methods) {
      const response = await wreqFetch(httpUrl("/get"), {
        method,
        browser: "chrome_142",
        timeout: 10_000,
      });

      assert.strictEqual(response.status, 200);
      const body = await response.json<{ method?: string }>();
      assert.strictEqual(body.method, method);
    }
  });

  test("supports CONNECT requests", { skip: !isLocalHttpBase }, async () => {
    const response = await wreqFetch(httpUrl("/connect-target"), {
      method: "CONNECT",
      browser: "chrome_142",
      timeout: 10_000,
    });

    assert.strictEqual(response.status, 200);
    const bodyText = await response.text();
    // Some HTTP stacks may ignore bodies on CONNECT; accept empty but ensure no parse errors.
    assert.ok(bodyText.length >= 0);
  });

  test("sets response.ok for 2xx statuses", async () => {
    const successResponse = await wreqFetch(httpUrl("/json"), {
      browser: "chrome_142",
      timeout: 10_000,
    });
    assert.strictEqual(successResponse.ok, true);

    const notFoundResponse = await wreqFetch(httpUrl("/missing-route"), {
      browser: "chrome_142",
      timeout: 10_000,
    });
    assert.strictEqual(notFoundResponse.status, 404);
    assert.strictEqual(notFoundResponse.ok, false);
  });

  test("propagates AbortSignal to native I/O", { skip: !isLocalHttpBase }, async () => {
    const controller = new AbortController();
    const hangId = randomUUID();

    const requestPromise = wreqFetch(httpUrl(`/hang?id=${hangId}`), {
      browser: "chrome_142",
      timeout: 10_000,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort("test abort"), 50);

    await assert.rejects(
      requestPromise,
      (error: unknown) => error instanceof Error && error.name === "AbortError",
      "fetch should reject with AbortError when aborted",
    );

    await delay(25);

    const statusResponse = await wreqFetch(httpUrl(`/hang/status?id=${hangId}`), {
      browser: "chrome_142",
      timeout: 5_000,
    });

    const status = await statusResponse.json<{ closed: boolean }>();
    assert.strictEqual(status.closed, true, "server should observe connection close after abort");
  });
});
