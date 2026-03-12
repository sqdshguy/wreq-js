import assert from "node:assert";
import { describe, test } from "node:test";
import { RequestError, fetch as wreqFetch } from "../../wreq-js.js";
import { headerIndex, httpUrl } from "../helpers/http.js";

describe("HTTP custom emulation", () => {
  test("fetch with only emulation.headers and no browser/os sends standalone emulation headers", async () => {
    const response = await wreqFetch(httpUrl("/headers"), {
      emulation: {
        headers: {
          "User-Agent": "Standalone Agent/1.0",
          "X-Standalone": "alpha",
        },
      },
      timeout: 10_000,
    });

    assert.strictEqual(response.status, 200);
    const body = await response.json<{ headers: Record<string, string> }>();
    assert.strictEqual(body.headers["User-Agent"], "Standalone Agent/1.0");
    assert.strictEqual(body.headers["X-Standalone"], "alpha");
  });

  test("standalone custom mode suppresses emulation.headers when disableDefaultHeaders is true", async () => {
    const response = await wreqFetch(httpUrl("/headers"), {
      emulation: {
        headers: {
          "User-Agent": "Standalone Agent/1.0",
          "X-Standalone": "alpha",
        },
      },
      headers: {
        "X-Explicit": "beta",
      },
      disableDefaultHeaders: true,
      timeout: 10_000,
    });

    assert.strictEqual(response.status, 200);
    const body = await response.json<{ headers: Record<string, string> }>();
    assert.strictEqual(body.headers["X-Explicit"], "beta");
    assert.strictEqual(body.headers["X-Standalone"], undefined);
    assert.strictEqual(body.headers["User-Agent"], undefined);
  });

  test("standalone custom mode preserves origHeaders order and casing", async () => {
    const response = await wreqFetch(httpUrl("/headers"), {
      emulation: {
        headers: [
          ["x-lower", "one"],
          ["X-Mixed", "two"],
        ],
        origHeaders: ["X-Mixed", "x-lower"],
      },
      timeout: 10_000,
    });

    assert.strictEqual(response.status, 200);
    const body = await response.json<{ rawHeaders: string[] }>();

    const exactMixedIndex = body.rawHeaders.findIndex((value, index) => index % 2 === 0 && value === "X-Mixed");
    const exactLowerIndex = body.rawHeaders.findIndex((value, index) => index % 2 === 0 && value === "x-lower");

    assert.ok(exactMixedIndex !== -1, "X-Mixed should preserve casing");
    assert.ok(exactLowerIndex !== -1, "x-lower should preserve casing");
    assert.ok(exactMixedIndex < exactLowerIndex, "origHeaders should control header ordering");
  });

  test("existing browser API still supports preset browser mode unchanged", async () => {
    const response = await wreqFetch(httpUrl("/user-agent"), {
      browser: "chrome_142",
      timeout: 10_000,
    });

    assert.strictEqual(response.status, 200);
    const body = await response.json<{ "user-agent": string }>();
    assert.match(body["user-agent"], /Chrome\/142/i);
  });

  test("existing browser API still treats os without browser as default browser plus os", async () => {
    const response = await wreqFetch(httpUrl("/user-agent"), {
      os: "windows",
      timeout: 10_000,
    });

    assert.strictEqual(response.status, 200);
    const body = await response.json<{ "user-agent": string }>();
    assert.match(body["user-agent"], /Windows/i);
    assert.match(body["user-agent"], /Chrome/i);
  });

  test("existing browser API still treats browser plus emulation as preset plus overrides", async () => {
    const response = await wreqFetch(httpUrl("/headers"), {
      browser: "chrome_142",
      emulation: {
        headers: {
          "X-Overlay": "gamma",
        },
      },
      timeout: 10_000,
    });

    assert.strictEqual(response.status, 200);
    const body = await response.json<{ headers: Record<string, string> }>();
    assert.strictEqual(body.headers["X-Overlay"], "gamma");
    assert.ok(body.headers["User-Agent"], "preset user agent should still be present");
  });

  test("rejects empty standalone emulation", async () => {
    await assert.rejects(
      wreqFetch(httpUrl("/get"), { emulation: {} }),
      (error: unknown) =>
        error instanceof RequestError && /Standalone custom emulation requires at least one/.test(error.message),
    );
  });

  test("rejects invalid extensionPermutation entries", async () => {
    await assert.rejects(
      wreqFetch(httpUrl("/get"), {
        emulation: {
          tlsOptions: {
            extensionPermutation: [10, 70000],
          },
        },
      }),
      (error: unknown) =>
        error instanceof RequestError &&
        /emulation\.tlsOptions\.extensionPermutation must be between 0 and 65535/.test(error.message),
    );
  });

  test("rejects duplicate priority stream ids", async () => {
    await assert.rejects(
      wreqFetch(httpUrl("/get"), {
        emulation: {
          http2Options: {
            priorities: [
              { streamId: 3, dependency: { dependencyId: 0, weight: 1 } },
              { streamId: 3, dependency: { dependencyId: 1, weight: 2 } },
            ],
          },
        },
      }),
      (error: unknown) =>
        error instanceof RequestError && /Duplicate emulation\.http2Options\.priorities streamId/.test(error.message),
    );
  });

  test("rejects duplicate experimental setting ids", async () => {
    await assert.rejects(
      wreqFetch(httpUrl("/get"), {
        emulation: {
          http2Options: {
            experimentalSettings: [
              { id: 14, value: 1 },
              { id: 14, value: 2 },
            ],
          },
        },
      }),
      (error: unknown) =>
        error instanceof RequestError &&
        /Duplicate emulation\.http2Options\.experimentalSettings id/.test(error.message),
    );
  });

  test("rejects standard setting ids inside experimentalSettings", async () => {
    await assert.rejects(
      wreqFetch(httpUrl("/get"), {
        emulation: {
          http2Options: {
            experimentalSettings: [{ id: 1, value: 1 }],
          },
        },
      }),
      (error: unknown) =>
        error instanceof RequestError && /must not be a standard HTTP\/2 setting id/.test(error.message),
    );
  });

  test("rejects readBufExactSize and maxBufSize together", async () => {
    await assert.rejects(
      wreqFetch(httpUrl("/get"), {
        emulation: {
          http1Options: {
            readBufExactSize: 4096,
            maxBufSize: 8192,
          },
        },
      }),
      (error: unknown) =>
        error instanceof RequestError && /readBufExactSize and maxBufSize cannot both be set/.test(error.message),
    );
  });

  test("standalone origHeaders order is reflected in rawHeaders positions", async () => {
    const response = await wreqFetch(httpUrl("/headers"), {
      emulation: {
        headers: {
          "X-First": "one",
          "X-Second": "two",
        },
        origHeaders: ["X-Second", "X-First"],
      },
      timeout: 10_000,
    });

    const body = await response.json<{ rawHeaders: string[] }>();
    const firstIndex = headerIndex(body.rawHeaders, "X-First");
    const secondIndex = headerIndex(body.rawHeaders, "X-Second");

    assert.ok(firstIndex !== -1);
    assert.ok(secondIndex !== -1);
    assert.ok(secondIndex < firstIndex);
  });
});
