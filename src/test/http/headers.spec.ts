import assert from "node:assert";
import { describe, test } from "node:test";
import { Headers, fetch as wreqFetch } from "../../wreq-js.js";
import { headerIndex, httpUrl } from "../helpers/http.js";

describe("HTTP headers", () => {
  test("disables default headers when requested", async () => {
    const customAccept = "*/*";
    const response = await wreqFetch(httpUrl("/headers"), {
      browser: "chrome_142",
      headers: {
        Accept: customAccept,
      },
      disableDefaultHeaders: true,
      timeout: 10000,
    });

    assert.strictEqual(response.status, 200, "Should return status 200");

    const body = await response.json<{ headers: Record<string, string> }>();

    assert.strictEqual(
      body.headers.Accept,
      customAccept,
      "Should use only custom Accept header without emulation headers appended",
    );
  });

  test("appends emulation headers by default", async () => {
    const customAccept = "*/*";
    const response = await wreqFetch(httpUrl("/headers"), {
      browser: "chrome_142",
      headers: {
        Accept: customAccept,
      },
      timeout: 10000,
    });

    assert.strictEqual(response.status, 200, "Should return status 200");
    const body = await response.json<{ headers: Record<string, string> }>();
    const accept = body.headers.Accept;

    assert.ok(accept, "Should have Accept header");
    assert.ok(accept.includes(customAccept), "Should include custom Accept header");
  });

  test("maintains header ordering for Headers instances", async () => {
    const orderedHeaders = new Headers();
    orderedHeaders.append("X-First", "one");
    orderedHeaders.append("X-Second", "two");
    orderedHeaders.append("X-Third", "three");

    const response = await wreqFetch(httpUrl("/headers"), {
      browser: "chrome_142",
      headers: orderedHeaders,
      disableDefaultHeaders: true,
      timeout: 10000,
    });

    assert.strictEqual(response.status, 200, "Should return status 200");
    const body = await response.json<{ rawHeaders: string[] }>();
    assert.ok(body.rawHeaders, "Should include rawHeaders in the response");

    const firstIndex = headerIndex(body.rawHeaders, "X-First");
    const secondIndex = headerIndex(body.rawHeaders, "X-Second");
    const thirdIndex = headerIndex(body.rawHeaders, "X-Third");

    assert.ok(firstIndex !== -1, "X-First header should be present");
    assert.ok(secondIndex !== -1, "X-Second header should be present");
    assert.ok(thirdIndex !== -1, "X-Third header should be present");
    assert.ok(firstIndex < secondIndex, "X-First should appear before X-Second");
    assert.ok(secondIndex < thirdIndex, "X-Second should appear before X-Third");
  });

  test("maintains header ordering for plain objects", async () => {
    const response = await wreqFetch(httpUrl("/headers"), {
      browser: "chrome_142",
      headers: {
        "X-Start": "alpha",
        "X-Middle": "beta",
        "X-End": "gamma",
      },
      disableDefaultHeaders: true,
      timeout: 10000,
    });

    assert.strictEqual(response.status, 200, "Should return status 200");
    const body = await response.json<{ rawHeaders: string[] }>();
    assert.ok(body.rawHeaders, "Should include rawHeaders in the response");

    const startIndex = headerIndex(body.rawHeaders, "X-Start");
    const middleIndex = headerIndex(body.rawHeaders, "X-Middle");
    const endIndex = headerIndex(body.rawHeaders, "X-End");

    assert.ok(startIndex !== -1, "X-Start header should be present");
    assert.ok(middleIndex !== -1, "X-Middle header should be present");
    assert.ok(endIndex !== -1, "X-End header should be present");
    assert.ok(startIndex < middleIndex, "X-Start should precede X-Middle");
    assert.ok(middleIndex < endIndex, "X-Middle should precede X-End");
  });

  test("supports the Headers helper API", () => {
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

  test("headerOverrides replaces specific emulation headers", async () => {
    const customAccept = "text/html";
    const response = await wreqFetch(httpUrl("/headers"), {
      browser: "chrome_142",
      headerOverrides: [["Accept", customAccept]],
      timeout: 10000,
    });

    assert.strictEqual(response.status, 200, "Should return status 200");
    const body = await response.json<{ headers: Record<string, string>; rawHeaders: string[] }>();

    assert.strictEqual(body.headers.Accept, customAccept, "Accept should be overridden to custom value");
    assert.ok(body.headers["User-Agent"], "User-Agent emulation header should be preserved");
  });

  test("headerOverrides with headers coexist", async () => {
    const response = await wreqFetch(httpUrl("/headers"), {
      browser: "chrome_142",
      headers: { "X-Custom": "foo" },
      headerOverrides: [["Accept", "text/html"]],
      timeout: 10000,
    });

    assert.strictEqual(response.status, 200, "Should return status 200");
    const body = await response.json<{ headers: Record<string, string> }>();

    assert.strictEqual(body.headers.Accept, "text/html", "Accept should be overridden");
    assert.strictEqual(body.headers["X-Custom"], "foo", "Custom header should be present");
    assert.ok(body.headers["User-Agent"], "User-Agent emulation header should be preserved");
  });
});
