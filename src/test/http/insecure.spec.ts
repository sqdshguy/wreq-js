import assert from "node:assert";
import { describe, test } from "node:test";
import { createSession, fetch as wreqFetch } from "../../wreq-js.js";

// Local HTTPS test servers with certificate issues (provided by test runner)
const SELF_SIGNED_URL = process.env.HTTPS_SELF_SIGNED_URL;
const EXPIRED_URL = process.env.HTTPS_EXPIRED_URL;

if (!SELF_SIGNED_URL || !EXPIRED_URL) {
  throw new Error("HTTPS_SELF_SIGNED_URL and HTTPS_EXPIRED_URL must be set by the test runner");
}

/** Check if error message indicates a certificate verification failure */
function isCertificateError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return msg.includes("certificate") || msg.includes("ssl") || msg.includes("tls");
}

describe("Insecure certificate verification", () => {
  test("rejects self-signed certificates by default", async () => {
    await assert.rejects(
      wreqFetch(SELF_SIGNED_URL, {
        browser: "chrome_142",
        timeout: 10_000,
      }),
      isCertificateError,
      "Should reject self-signed certificates by default",
    );
  });

  test("accepts self-signed certificates when insecure is enabled", async () => {
    const response = await wreqFetch(`${SELF_SIGNED_URL}/json`, {
      browser: "chrome_142",
      timeout: 10_000,
      insecure: true,
    });

    assert.ok(
      response.status >= 200 && response.status < 400,
      "Should accept self-signed certificate with insecure flag",
    );
  });

  test("rejects expired certificates by default", async () => {
    await assert.rejects(
      wreqFetch(EXPIRED_URL, {
        browser: "chrome_142",
        timeout: 10_000,
      }),
      isCertificateError,
      "Should reject expired certificates by default",
    );
  });

  test("accepts expired certificates when insecure is enabled", async () => {
    const response = await wreqFetch(`${EXPIRED_URL}/json`, {
      browser: "chrome_142",
      timeout: 10_000,
      insecure: true,
    });

    assert.ok(response.status >= 200 && response.status < 400, "Should accept expired certificate with insecure flag");
  });

  test("rejects self-signed certificates in sessions by default", async () => {
    const session = await createSession({
      browser: "chrome_142",
      timeout: 10_000,
    });

    try {
      await assert.rejects(
        session.fetch(SELF_SIGNED_URL, {
          timeout: 10_000,
        }),
        isCertificateError,
        "Session should reject self-signed certificates by default",
      );
    } finally {
      await session.close();
    }
  });

  test("accepts self-signed certificates in sessions with insecure enabled", async () => {
    const session = await createSession({
      browser: "chrome_142",
      timeout: 10_000,
      insecure: true,
    });

    try {
      const response = await session.fetch(`${SELF_SIGNED_URL}/json`, {
        timeout: 10_000,
      });

      assert.ok(
        response.status >= 200 && response.status < 400,
        "Session should accept self-signed certificate with insecure flag",
      );
    } finally {
      await session.close();
    }
  });

  test("session insecure setting applies to all requests", async () => {
    const session = await createSession({
      browser: "chrome_142",
      timeout: 10_000,
      insecure: true,
    });

    try {
      // Test multiple hosts with certificate issues
      const response1 = await session.fetch(`${SELF_SIGNED_URL}/json`, {
        timeout: 10_000,
      });

      const response2 = await session.fetch(`${EXPIRED_URL}/json`, {
        timeout: 10_000,
      });

      assert.ok(response1.status >= 200 && response1.status < 400, "Should handle first insecure request");
      assert.ok(response2.status >= 200 && response2.status < 400, "Should handle second insecure request");
    } finally {
      await session.close();
    }
  });

  test("insecure defaults to false", async () => {
    // Test that omitting the insecure option still validates certificates
    await assert.rejects(
      wreqFetch(SELF_SIGNED_URL, {
        browser: "chrome_142",
        timeout: 10_000,
        // insecure not specified, should default to false
      }),
      isCertificateError,
      "Should validate certificates when insecure is not specified",
    );
  });

  test("insecure: false explicitly validates certificates", async () => {
    await assert.rejects(
      wreqFetch(SELF_SIGNED_URL, {
        browser: "chrome_142",
        timeout: 10_000,
        insecure: false,
      }),
      isCertificateError,
      "Should validate certificates when insecure is explicitly false",
    );
  });
});
