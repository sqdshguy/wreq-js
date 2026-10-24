import assert from "node:assert";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import { createSession, createTransport, RequestError, fetch as wreqFetch } from "../../wreq-js.js";

const SELF_SIGNED_URL = process.env.HTTPS_SELF_SIGNED_URL;
const CUSTOM_CA_URL = process.env.HTTPS_CUSTOM_CA_URL;

if (!SELF_SIGNED_URL || !CUSTOM_CA_URL) {
  throw new Error("HTTPS_SELF_SIGNED_URL and HTTPS_CUSTOM_CA_URL must be set by the test runner");
}

const CUSTOM_CA_PORT = new URL(CUSTOM_CA_URL).port;

// `.invalid` is reserved by RFC 6761 and never resolves, so the only way a
// request reaches the local server is through the resolve override.
const PINNED_HOST = "wreq-resolve-test.invalid";
const PORT = new URL(SELF_SIGNED_URL).port;
const PINNED_URL = `https://${PINNED_HOST}:${PORT}/json`;

describe("DNS resolve override", () => {
  test("routes an otherwise unresolvable host to the provided address", async () => {
    const transport = await createTransport({
      browser: "chrome_142",
      insecure: true,
      resolve: { [PINNED_HOST]: `127.0.0.1:${PORT}` },
    });

    try {
      const response = await wreqFetch(PINNED_URL, { transport, timeout: 10_000 });

      assert.equal(response.status, 200);
      const body = (await response.json()) as { message?: string };
      assert.equal(body.message, "local test server");
    } finally {
      await transport.close();
    }
  });

  test("accepts an array of addresses for a host", async () => {
    const transport = await createTransport({
      browser: "chrome_142",
      insecure: true,
      resolve: { [PINNED_HOST]: [`127.0.0.1:${PORT}`] },
    });

    try {
      const response = await wreqFetch(PINNED_URL, { transport, timeout: 10_000 });

      assert.equal(response.status, 200);
    } finally {
      await transport.close();
    }
  });

  test("accepts a bare IP address without a port", async () => {
    const transport = await createTransport({
      browser: "chrome_142",
      insecure: true,
      resolve: { [PINNED_HOST]: "127.0.0.1" },
    });

    try {
      const response = await wreqFetch(PINNED_URL, { transport, timeout: 10_000 });

      assert.equal(response.status, 200);
    } finally {
      await transport.close();
    }
  });

  test("fails without an override because the host cannot be resolved", async () => {
    await assert.rejects(
      wreqFetch(PINNED_URL, { browser: "chrome_142", insecure: true, timeout: 10_000 }),
      "Request to an unresolvable host should fail without a resolve override",
    );
  });

  test("rejects a malformed resolve address", async () => {
    await assert.rejects(
      createTransport({
        browser: "chrome_142",
        resolve: { [PINNED_HOST]: "not-an-ip-address" },
      }),
      "createTransport should reject an invalid resolve address",
    );
  });

  test("keeps certificate verification enabled when pinning a matching host", async () => {
    const transport = await createTransport({
      browser: "chrome_142",
      trustStore: "defaultPaths",
      resolve: { localhost: `127.0.0.1:${CUSTOM_CA_PORT}` },
    });

    try {
      const response = await wreqFetch(`https://localhost:${CUSTOM_CA_PORT}/json`, { transport, timeout: 10_000 });

      assert.equal(response.status, 200);
    } finally {
      await transport.close();
    }
  });

  test("validates the certificate against the request host, not the pinned address", async () => {
    // The custom-CA cert covers only localhost. Pinning an unrelated host to that
    // server reaches the pinned address, but verification runs against the request
    // host's SNI and must fail.
    const transport = await createTransport({
      browser: "chrome_142",
      trustStore: "defaultPaths",
      resolve: { [PINNED_HOST]: `127.0.0.1:${CUSTOM_CA_PORT}` },
    });

    try {
      await assert.rejects(
        wreqFetch(`https://${PINNED_HOST}:${CUSTOM_CA_PORT}/json`, { transport, timeout: 10_000 }),
        "certificate verification should fail for a host the certificate does not cover",
      );
    } finally {
      await transport.close();
    }
  });

  test("rejects a resolve value that is not an object", async () => {
    await assert.rejects(
      createTransport({
        browser: "chrome_142",
        resolve: "127.0.0.1" as unknown as Record<string, string>,
      }),
      "createTransport should reject a non-object resolve",
    );
  });

  test("rejects an empty address list for a host", async () => {
    await assert.rejects(
      createTransport({
        browser: "chrome_142",
        resolve: { [PINNED_HOST]: [] },
      }),
      "createTransport should reject an empty address list",
    );
  });

  test("rejects a non-string resolve address", async () => {
    await assert.rejects(
      createTransport({
        browser: "chrome_142",
        resolve: { [PINNED_HOST]: [123 as unknown as string] },
      }),
      "createTransport should reject a non-string address",
    );
  });

  test("pins a host for a single request without a transport", async () => {
    const response = await wreqFetch(PINNED_URL, {
      browser: "chrome_142",
      insecure: true,
      resolve: { [PINNED_HOST]: "127.0.0.1" },
      timeout: 10_000,
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as { message?: string };
    assert.equal(body.message, "local test server");
  });

  test("a pinned request does not lend its address to the next request", async () => {
    const options = { browser: "chrome_142", insecure: true, timeout: 10_000 } as const;
    const pinned = await wreqFetch(PINNED_URL, { ...options, resolve: { [PINNED_HOST]: "127.0.0.1" } });
    assert.equal(pinned.status, 200);
    await pinned.text();

    await assert.rejects(wreqFetch(PINNED_URL, options), "the unpinned request should not reach the host");
  });

  test("rejects a per-request resolve combined with a transport", async () => {
    const transport = await createTransport({ browser: "chrome_142", insecure: true });

    try {
      await assert.rejects(wreqFetch(PINNED_URL, { transport, resolve: { [PINNED_HOST]: "127.0.0.1" } }), RequestError);
    } finally {
      await transport.close();
    }
  });

  test("rejects a per-request resolve on a session", async () => {
    const session = await createSession({ browser: "chrome_142", insecure: true });

    try {
      await assert.rejects(session.fetch(PINNED_URL, { resolve: { [PINNED_HOST]: "127.0.0.1" } }), RequestError);
    } finally {
      await session.close();
    }
  });

  test("rejects a malformed per-request resolve address", async () => {
    await assert.rejects(
      wreqFetch(PINNED_URL, { browser: "chrome_142", resolve: { [PINNED_HOST]: "not-an-ip-address" } }),
      (error: unknown) => error instanceof RequestError && /Invalid resolve address/.test(error.message),
    );
  });

  test("pins requests that share cookies through a sessionId", async () => {
    const base = `https://${PINNED_HOST}:${PORT}`;
    const options = {
      browser: "chrome_142",
      insecure: true,
      sessionId: `resolve-${Date.now()}`,
      cookieMode: "session",
      resolve: { [PINNED_HOST]: "127.0.0.1" },
      timeout: 10_000,
    } as const;

    const set = await wreqFetch(`${base}/cookies/set?pinned=yes`, options);
    assert.equal(set.status, 200);
    await set.text();

    const echoed = await wreqFetch(`${base}/cookies`, options);
    const body = (await echoed.json()) as { cookies?: Record<string, string> };
    assert.equal(body.cookies?.pinned, "yes");
  });

  test("a redirect to another host is not pinned, and redirect: manual stops before it", async () => {
    let redirected = 0;
    const landed: string[] = [];
    const server = createServer((req, res) => {
      if (req.url === "/landed") {
        landed.push(req.headers.host ?? "");
        res.end("landed");
        return;
      }
      redirected += 1;
      res.writeHead(302, { Location: `http://unpinned-target.invalid:${port}/landed` });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const url = `http://${PINNED_HOST}:${port}/`;
    const resolve = { [PINNED_HOST]: "127.0.0.1" };

    try {
      // Followed, the redirect target goes through normal DNS, which cannot resolve it.
      await assert.rejects(wreqFetch(url, { resolve, timeout: 10_000 }), RequestError);
      assert.equal(redirected, 1, "the pinned first hop should have reached the server");

      const response = await wreqFetch(url, { resolve, redirect: "manual", timeout: 10_000 });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), `http://unpinned-target.invalid:${port}/landed`);
      assert.deepEqual(landed, [], "the redirect target must not have been requested");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
