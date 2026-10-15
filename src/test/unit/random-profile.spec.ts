import assert from "node:assert";
import { describe, test } from "node:test";
import {
  type BrowserAlias,
  type EmulationOS,
  getEmulationHeaders,
  getProfiles,
  RequestError,
  randomProfile,
  resolveProfile,
} from "../../wreq-js.js";

const ALL_FAMILIES: BrowserAlias[] = [
  "chrome",
  "edge",
  "firefox",
  "firefox_android",
  "firefox_private",
  "okhttp",
  "opera",
  "safari",
  "safari_ios",
  "safari_ipad",
];
const ALL_OSES: EmulationOS[] = ["windows", "macos", "linux", "android", "ios"];

// The platform a User-Agent claims, to check a pick against what the emulation sends.
function platformOf(userAgent: string): EmulationOS | "unknown" {
  if (/Windows NT/.test(userAgent)) return "windows";
  if (/iPhone|iPad|CPU OS/.test(userAgent)) return "ios";
  if (/Android/.test(userAgent)) return "android";
  if (/Macintosh/.test(userAgent)) return "macos";
  if (/X11|Linux/.test(userAgent)) return "linux";
  return "unknown";
}

// Every distinct pick reachable with these options, found by sweeping the random source.
function reachable(options: Parameters<typeof randomProfile>[0] = {}): Set<string> {
  const seen = new Set<string>();
  const steps = 60;
  for (let a = 0; a < steps; a += 1) {
    for (let b = 0; b < steps; b += 1) {
      for (let c = 0; c < steps; c += 1) {
        const values = [a / steps, b / steps, c / steps];
        let i = 0;
        const pick = randomProfile({ ...options, random: () => values[i++] as number });
        seen.add(`${pick.browser}@${pick.os}`);
      }
    }
  }
  return seen;
}

describe("randomProfile", () => {
  test("the newest profile in each family is the one its alias points at", () => {
    for (const family of ALL_FAMILIES) {
      const pick = randomProfile({ families: [family], latest: 1, os: ALL_OSES });
      assert.strictEqual(pick.browser, resolveProfile(family), `newest ${family}`);
    }
  });

  test("defaults pick from the two newest desktop profiles on desktop operating systems", () => {
    const picks = reachable();
    const expectedBrowsers = new Set<string>();
    for (const family of ["chrome", "edge", "firefox", "opera", "safari"] as const) {
      const newest = resolveProfile(family);
      expectedBrowsers.add(newest);
      const all = getProfiles().filter((p) => p.startsWith(`${family}_`) && /^\d/.test(p.slice(family.length + 1)));
      assert.ok(all.includes(newest));
    }

    const browsers = new Set([...picks].map((p) => p.split("@")[0]));
    const oses = new Set([...picks].map((p) => p.split("@")[1]));
    assert.strictEqual(browsers.size, 10, `expected 2 profiles x 5 families, got ${[...browsers].join(", ")}`);
    for (const browser of expectedBrowsers) {
      assert.ok(browsers.has(browser), `${browser} should be reachable`);
    }
    assert.deepStrictEqual([...oses].sort(), ["linux", "macos", "windows"]);
    for (const pick of picks) {
      if (pick.startsWith("safari_")) assert.ok(pick.endsWith("@macos"), pick);
      if (pick.startsWith("opera_")) assert.ok(!pick.endsWith("@linux"), pick);
    }
  });

  test("no reachable pick presents a different operating system than it claims", () => {
    const picks = reachable({ families: ALL_FAMILIES, latest: 2, os: ALL_OSES });
    for (const pick of picks) {
      const [browser, os] = pick.split("@") as [string, EmulationOS];
      const userAgent = getEmulationHeaders(browser as Parameters<typeof getEmulationHeaders>[0], os).get("user-agent");
      // Some clients (okhttp) name no platform at all; that cannot contradict the pick.
      const claimed = platformOf(userAgent ?? "");
      assert.ok(claimed === os || claimed === "unknown", `${pick}: ${userAgent}`);
    }
  });

  test("desktop browsers are never paired with iOS", () => {
    const picks = reachable({ families: ["chrome", "edge", "firefox"], os: ALL_OSES });
    for (const pick of picks) {
      assert.ok(!pick.endsWith("@ios"), pick);
    }
  });

  test("mobile options yield mobile operating systems only", () => {
    const picks = reachable({ families: ["chrome", "safari_ios", "firefox_android"], os: ["android", "ios"] });
    for (const pick of picks) {
      assert.ok(pick.endsWith("@android") || pick.endsWith("@ios"), pick);
      if (pick.startsWith("safari_ios_")) assert.ok(pick.endsWith("@ios"), pick);
    }
  });

  test("a random source returning 1 still picks an element", () => {
    const pick = randomProfile({ random: () => 1 });
    assert.ok(getProfiles().includes(pick.browser));
  });

  test("rejects invalid options", () => {
    assert.throws(() => randomProfile({ latest: 0 }), RequestError);
    assert.throws(() => randomProfile({ latest: 1.5 }), RequestError);
    assert.throws(() => randomProfile({ families: ["netscape" as BrowserAlias] }), RequestError);
    assert.throws(() => randomProfile({ os: ["beos" as EmulationOS] }), RequestError);
    assert.throws(() => randomProfile({ families: ["safari"], os: ["windows"] }), /No browser family/);
  });
});
