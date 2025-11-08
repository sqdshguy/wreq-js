import assert from "node:assert";
import { before, describe, test } from "node:test";
import type { BrowserProfile } from "../wreq-js";
import { getProfiles, Headers, RequestError, fetch as wreqFetch } from "../wreq-js";

describe("HTTP", () => {
  before(() => {
    console.log("🔌 HTTP Test Suite\n");
  });

  test("should return available browser profiles", () => {
    const profiles = getProfiles();

    assert.ok(Array.isArray(profiles), "Profiles should be an array");
    assert.ok(profiles.length > 0, "Should have at least one profile");
    assert.ok(
      profiles.some((p) => p.includes("chrome")) ||
        profiles.some((p) => p.includes("firefox")) ||
        profiles.some((p) => p.includes("safari")),
      "Should include standard browser profiles",
    );

    console.log("Available profiles:", profiles.join(", "));
  });

  test("should make a simple GET request", async () => {
    const response = await wreqFetch("https://httpbingo.org/get", {
      browser: "chrome_131",
      timeout: 10000,
    });

    assert.ok(response.status >= 200 && response.status < 300, "Should return successful status");
    assert.ok(response.headers.has("content-type"), "Should have response headers");

    const body = await response.json<{ headers: Record<string, string> }>();

    assert.ok(body.headers["User-Agent"], "Should have User-Agent header");
    assert.ok(response.bodyUsed, "json() should mark the body as used");

    console.log("Status:", response.status);
    console.log("User-Agent:", body.headers["User-Agent"]);
  });

  test("should work with different browser profiles", async () => {
    const testUrl = "https://httpbingo.org/user-agent";
    const browsers = ["chrome_142", "firefox_139", "safari_18"] as const;

    for (const browser of browsers) {
      const response = await wreqFetch(testUrl, {
        browser,
        timeout: 10000,
      });

      assert.ok(response.status === 200, `${browser} should return status 200`);

      const data = JSON.parse(response.body);

      assert.ok(data["user-agent"], `${browser} should have user-agent`);

      console.log(`${browser}:`, `${data["user-agent"].substring(0, 70)}...`);
    }
  });

  test("should handle timeout errors", async () => {
    await assert.rejects(
      async () => {
        await wreqFetch("https://httpbingo.org/delay/10", {
          browser: "chrome_142",
          timeout: 1000, // 1 second timeout for 10 second delay
        });
      },
      {
        name: "RequestError",
      },
      "Should throw an error on timeout",
    );
  });

  test("should provide functional clone and text helpers", async () => {
    const response = await wreqFetch("https://httpbingo.org/json", {
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

  test("should reject aborted requests with AbortError", async () => {
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      async () => {
        await wreqFetch("https://httpbingo.org/get", {
          browser: "chrome_142",
          signal: controller.signal,
          timeout: 1000,
        });
      },
      (error: unknown) => error instanceof Error && error.name === "AbortError",
      "Should reject with AbortError",
    );
  });

  test("should work with custom Headers helper", () => {
    const headers = new Headers({
      "X-Test": "alpha",
    });

    headers.append("x-test", "beta");
    headers.set("X-Another", "value");

    const collected = Array.from(headers.entries());

    assert.strictEqual(headers.get("X-Test"), "alpha, beta", "append should concatenate values");
    assert.strictEqual(headers.get("x-another"), "value", "set should overwrite values");
    assert.ok(collected.length >= 2, "entries should iterate all headers");
  });

  test("should validate browser profiles in fetch", async () => {
    await assert.rejects(
      async () => {
        await wreqFetch("https://httpbingo.org/get", {
          browser: "nonexistent_browser" as BrowserProfile,
          timeout: 1000,
        });
      },
      (error: unknown) => error instanceof RequestError,
      "Should reject invalid browser profiles",
    );
  });
});
