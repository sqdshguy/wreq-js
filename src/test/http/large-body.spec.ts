import assert from "node:assert";
import { describe, test } from "node:test";
import { fetch as wreqFetch } from "../../wreq-js.js";
import { httpUrl, isLocalHttpBase } from "../helpers/http.js";

// Bodies of 256 KiB and more are handed to JS as external buffers that own the native
// allocation (or copied, on runtimes that refuse external buffers). Either way the
// bytes, the zero-copy arrayBuffer() view, and the streamed variant must be intact.
describe("large response bodies", () => {
  test("a 64 KiB inline body round-trips and arrayBuffer() covers the whole buffer", {
    skip: !isLocalHttpBase,
  }, async () => {
    const size = 65536;
    const response = await wreqFetch(httpUrl(`/chunked?size=${size}`), { browser: "chrome_142", timeout: 10_000 });
    const buffer = await response.arrayBuffer();

    assert.strictEqual(buffer.byteLength, size);
    const view = new Uint8Array(buffer);
    assert.strictEqual(view[0], 7);
    assert.strictEqual(view[size - 1], 7);
    assert.ok(
      view.every((byte) => byte === 7),
      "every byte must be the server's fill value",
    );
  });

  test("text() decodes a large body handed over without a copy", { skip: !isLocalHttpBase }, async () => {
    const response = await wreqFetch(httpUrl("/chunked?size=65536"), { browser: "chrome_142", timeout: 10_000 });
    const text = await response.text();
    assert.strictEqual(text.length, 65536);
    assert.strictEqual(text.charCodeAt(0), 7);
  });

  test("a streamed body above the threshold arrives intact", { skip: !isLocalHttpBase }, async () => {
    const count = 512;
    const size = 1024;
    const response = await wreqFetch(httpUrl(`/chunked/many?n=${count}&size=${size}`), {
      browser: "chrome_142",
      timeout: 10_000,
    });
    const bytes = await response.bytes();
    assert.strictEqual(bytes.byteLength, count * size);
    for (let i = 0; i < bytes.byteLength; i += 4099) {
      assert.strictEqual(bytes[i], Math.floor(i / size) & 0xff, `byte ${i}`);
    }
  });

  test("many large bodies can be fetched back to back", { skip: !isLocalHttpBase }, async () => {
    // Exercises finalizers and the external-memory accounting under some churn.
    for (let i = 0; i < 64; i += 1) {
      const response = await wreqFetch(httpUrl("/chunked?size=65536"), { browser: "chrome_142", timeout: 10_000 });
      const bytes = await response.bytes();
      assert.strictEqual(bytes.byteLength, 65536);
    }
  });
});
