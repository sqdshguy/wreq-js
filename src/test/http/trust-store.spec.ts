import assert from "node:assert";
import { describe, test } from "node:test";
import { createSession, createTransport, RequestError, request, fetch as wreqFetch } from "../../wreq-js.js";

const CUSTOM_CA_URL = process.env.HTTPS_CUSTOM_CA_URL;
const SELF_SIGNED_URL = process.env.HTTPS_SELF_SIGNED_URL;

if (!CUSTOM_CA_URL || !SELF_SIGNED_URL) {
  throw new Error("HTTPS_CUSTOM_CA_URL and HTTPS_SELF_SIGNED_URL must be set by the test runner");
}

describe("Trust store selection", () => {
  test("combined trustStore is the default and accepts the custom CA endpoint", async () => {
    const response = await wreqFetch(`${CUSTOM_CA_URL}/json`, {
      browser: "chrome_142",
      timeout: 10_000,
    });

    assert.strictEqual(response.status, 200);
  });

  test("mozilla trustStore rejects the custom CA endpoint", async () => {
    await assert.rejects(
      wreqFetch(`${CUSTOM_CA_URL}/json`, {
        browser: "chrome_142",
        timeout: 10_000,
        trustStore: "mozilla",
      }),
      (error: unknown) => error instanceof Error && /certificate|ssl|tls/i.test(error.message),
    );
  });

  test("defaultPaths trustStore accepts the custom CA endpoint", async () => {
    const response = await wreqFetch(`${CUSTOM_CA_URL}/json`, {
      browser: "chrome_142",
      timeout: 10_000,
      trustStore: "defaultPaths",
    });

    assert.strictEqual(response.status, 200);
  });

  test("insecure bypasses trustStore selection for self-signed certificates", async () => {
    const mozillaResponse = await wreqFetch(`${SELF_SIGNED_URL}/json`, {
      browser: "chrome_142",
      timeout: 10_000,
      insecure: true,
      trustStore: "mozilla",
    });
    assert.strictEqual(mozillaResponse.status, 200);

    const defaultPathsResponse = await wreqFetch(`${SELF_SIGNED_URL}/json`, {
      browser: "chrome_142",
      timeout: 10_000,
      insecure: true,
      trustStore: "defaultPaths",
    });
    assert.strictEqual(defaultPathsResponse.status, 200);
  });

  test("invalid trustStore values are rejected before request dispatch", async () => {
    await assert.rejects(
      wreqFetch(`${CUSTOM_CA_URL}/json`, {
        browser: "chrome_142",
        timeout: 10_000,
        trustStore: "bogus" as never,
      }),
      (error: unknown) =>
        error instanceof RequestError &&
        /trustStore must be one of: combined, mozilla, defaultPaths/.test(error.message),
    );
  });

  test("legacy request() forwards trustStore", async () => {
    const response = await request({
      url: `${CUSTOM_CA_URL}/json`,
      browser: "chrome_142",
      timeout: 10_000,
      trustStore: "defaultPaths",
    });

    assert.strictEqual(response.status, 200);
  });

  test("session trustStore applies to all requests and cannot be overridden", async () => {
    const session = await createSession({
      browser: "chrome_142",
      timeout: 10_000,
      trustStore: "mozilla",
    });

    try {
      await assert.rejects(
        session.fetch(`${CUSTOM_CA_URL}/json`, { timeout: 10_000 }),
        (error: unknown) => error instanceof Error && /certificate|ssl|tls/i.test(error.message),
      );

      await assert.rejects(
        session.fetch(`${CUSTOM_CA_URL}/json`, {
          timeout: 10_000,
          trustStore: "defaultPaths",
        }),
        (error: unknown) =>
          error instanceof RequestError && /Session trustStore setting cannot be changed/.test(error.message),
      );
    } finally {
      await session.close();
    }
  });

  test("transport trustStore applies to requests and forbids per-request override", async () => {
    const transport = await createTransport({
      browser: "chrome_142",
      trustStore: "defaultPaths",
    });

    try {
      const response = await wreqFetch(`${CUSTOM_CA_URL}/json`, {
        timeout: 10_000,
        transport,
      });
      assert.strictEqual(response.status, 200);

      await assert.rejects(
        wreqFetch(`${CUSTOM_CA_URL}/json`, {
          timeout: 10_000,
          transport,
          trustStore: "mozilla",
        }),
        (error: unknown) =>
          error instanceof RequestError &&
          /`transport` cannot be combined with browser\/os\/emulation\/proxy\/insecure\/trustStore\/resolve options/.test(
            error.message,
          ),
      );
    } finally {
      await transport.close();
    }
  });
});
