import assert from "node:assert";
import { describe, test } from "node:test";
import type { BrowserProfile, EmulationOS } from "../../wreq-js.js";
import { getEmulationHeaders, getProfiles, RequestError, fetch as wreqFetch } from "../../wreq-js.js";
import { httpUrl } from "../helpers/http.js";

// Added by the client rather than the emulation profile, so they are not part of its header set.
const TRANSPORT_HEADERS = new Set(["host", "connection", "content-length", "accept-encoding"]);

describe("HTTP profiles", () => {
  test("returns available browser profiles", () => {
    const profiles = getProfiles();

    assert.ok(Array.isArray(profiles), "Profiles should be an array");
    assert.ok(profiles.length > 0, "Should have at least one profile");
    assert.ok(
      profiles.some((p) => p.includes("chrome")) ||
        profiles.some((p) => p.includes("firefox")) ||
        profiles.some((p) => p.includes("safari")),
      "Should include standard browser profiles",
    );
  });

  test("rejects invalid browser profiles", async () => {
    await assert.rejects(
      async () => {
        await wreqFetch(httpUrl("/get"), {
          browser: "nonexistent_browser" as BrowserProfile,
          timeout: 1000,
        });
      },
      (error: unknown) => error instanceof RequestError,
      "Should reject invalid browser profiles",
    );
  });

  test("exposes the headers a profile injects", () => {
    const headers = getEmulationHeaders("firefox_147");

    assert.ok(headers.get("user-agent")?.includes("Firefox/147"), "Should expose the profile's User-Agent");
    assert.ok(headers.get("accept"), "Should expose the profile's Accept header");
  });

  test("emulation headers follow the requested operating system", () => {
    const macos = getEmulationHeaders("chrome_142", "macos").get("user-agent");
    const windows = getEmulationHeaders("chrome_142", "windows").get("user-agent");

    assert.ok(macos?.includes("Mac OS X"), "macOS profile should report a macOS User-Agent");
    assert.ok(windows?.includes("Windows"), "Windows profile should report a Windows User-Agent");
    assert.notStrictEqual(macos, windows);
  });

  test("emulation headers match what the profile actually sends", async () => {
    for (const browser of ["firefox_147", "chrome_142", "safari_18"] as BrowserProfile[]) {
      const response = await wreqFetch(httpUrl("/headers"), { browser, timeout: 10_000 });
      const body = await response.json<{ rawHeaders: string[] }>();

      const sent = body.rawHeaders
        .filter((_, index) => index % 2 === 0)
        .map((name) => name.toLowerCase())
        .filter((name) => !TRANSPORT_HEADERS.has(name));
      const declared = [...getEmulationHeaders(browser)].map(([name]) => name.toLowerCase());

      // Header order is part of the fingerprint, so compare the sequence, not just the set.
      assert.deepStrictEqual(declared, sent, `${browser} should declare the headers it sends, in order`);
    }
  });

  test("returns a fresh Headers instance per call", () => {
    const first = getEmulationHeaders("chrome_142");
    first.set("user-agent", "mutated");

    assert.notStrictEqual(getEmulationHeaders("chrome_142").get("user-agent"), "mutated");
  });

  test("rejects invalid profiles and operating systems", () => {
    assert.throws(() => getEmulationHeaders("nonexistent_browser" as BrowserProfile), RequestError);
    assert.throws(() => getEmulationHeaders("chrome_142", "solaris" as EmulationOS), RequestError);
  });
});
