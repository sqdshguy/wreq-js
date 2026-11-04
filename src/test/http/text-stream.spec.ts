import assert from "node:assert";
import { describe, test } from "node:test";
import { fetch as wreqFetch } from "../../wreq-js.js";
import { httpUrl, isLocalHttpBase } from "../helpers/http.js";

async function collect(stream: ReadableStream<string>): Promise<string[]> {
  const parts: string[] = [];
  for await (const part of stream) {
    assert.strictEqual(typeof part, "string", "chunks should be decoded strings");
    parts.push(part);
  }
  return parts;
}

describe("response.textStream()", () => {
  test("decodes a UTF-8 body into string chunks", { skip: !isLocalHttpBase }, async () => {
    const text = "héllo wörld 👋 ✓";
    const response = await wreqFetch(httpUrl("/echo-body"), {
      browser: "chrome_142",
      method: "POST",
      body: text,
      timeout: 10_000,
    });

    const parts = await collect(response.textStream());
    assert.strictEqual(parts.join(""), text);
  });

  test("streams a chunked body", { skip: !isLocalHttpBase }, async () => {
    const chunkCount = 4;
    const chunkSize = 512;
    const response = await wreqFetch(httpUrl(`/stream/chunks?n=${chunkCount}&size=${chunkSize}`), {
      browser: "chrome_142",
      timeout: 10_000,
    });

    const parts = await collect(response.textStream());
    assert.strictEqual(parts.join("").length, chunkCount * chunkSize);
  });

  test("marks the body used and rejects a second read", { skip: !isLocalHttpBase }, async () => {
    const response = await wreqFetch(httpUrl("/json"), {
      browser: "chrome_142",
      timeout: 10_000,
    });

    const stream = response.textStream();
    assert.strictEqual(response.bodyUsed, true);
    assert.throws(() => response.textStream(), TypeError);
    await assert.rejects(response.text(), TypeError);

    await collect(stream);
  });

  test("throws when the body was already consumed", { skip: !isLocalHttpBase }, async () => {
    const response = await wreqFetch(httpUrl("/json"), {
      browser: "chrome_142",
      timeout: 10_000,
    });

    await response.text();
    assert.throws(() => response.textStream(), TypeError);
  });

  test("returns an empty closed stream for a null body", { skip: !isLocalHttpBase }, async () => {
    const response = await wreqFetch(httpUrl("/json"), {
      browser: "chrome_142",
      method: "HEAD",
      timeout: 10_000,
    });

    assert.strictEqual(response.body, null);
    assert.deepStrictEqual(await collect(response.textStream()), []);
  });
});
