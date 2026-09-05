import assert from "node:assert";
import { describe, test } from "node:test";
import { fetch as wreqFetch } from "../../wreq-js.js";
import { httpUrl, isLocalHttpBase } from "../helpers/http.js";

// Bodies without a Content-Length (chunked transfer, or anything compressed, since
// decoding drops the header) are inlined natively when they have already fully
// arrived by the time the response is handed to JS, so they take the same inline
// path as small known-length bodies. Nothing waits on the network for this.
// `contentLength` is only non-null when that happened, which makes the path
// observable from JS.
describe("inline body buffering for unknown-length responses", () => {
  test("small compressed responses are inlined with their decoded length", { skip: !isLocalHttpBase }, async () => {
    const response = await wreqFetch(httpUrl("/gzip"), { browser: "chrome_142", timeout: 10_000 });
    const body = await response.json<{ message: string; gzipped: boolean }>();

    assert.deepStrictEqual(body, { message: "compressed", gzipped: true });
    assert.strictEqual(response.contentLength, JSON.stringify(body).length, "decoded length should be reported");
  });

  test("a chunked body that has fully arrived is inlined", { skip: !isLocalHttpBase }, async () => {
    const response = await wreqFetch(httpUrl("/chunked?size=512"), {
      browser: "chrome_142",
      timeout: 10_000,
    });
    const bytes = await response.bytes();

    assert.strictEqual(bytes.byteLength, 512);
    assert.strictEqual(response.contentLength, 512);
  });

  test("a chunked body that stalls is still streamed, with the early bytes first", {
    skip: !isLocalHttpBase,
  }, async () => {
    const started = performance.now();
    const response = await wreqFetch(httpUrl("/stream/slow?gap=300"), {
      browser: "chrome_142",
      timeout: 10_000,
    });

    assert.strictEqual(response.contentLength, null, "a stalled body must not be inlined");
    assert.ok(performance.now() - started < 250, "headers must not wait for the stalled chunk");

    const reader = response.body?.getReader();
    assert.ok(reader);
    const first = await reader.read();
    assert.strictEqual(first.done, false);
    assert.ok(performance.now() - started < 250, "the first chunk must arrive before the stall ends");
    assert.strictEqual(first.value?.[0], 1, "the buffered prefix is replayed first");

    let total = first.value?.byteLength ?? 0;
    let last = first.value;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value?.byteLength ?? 0;
      last = next.value;
    }
    assert.strictEqual(total, 512);
    assert.strictEqual(last?.[last.byteLength - 1], 2, "the live tail follows the prefix");
  });

  test("text/event-stream responses deliver their first event immediately", { skip: !isLocalHttpBase }, async () => {
    const started = performance.now();
    const response = await wreqFetch(httpUrl("/sse"), { browser: "chrome_142", timeout: 10_000 });

    assert.strictEqual(response.contentLength, null);
    const reader = response.body?.getReader();
    assert.ok(reader);
    const first = await reader.read();
    assert.strictEqual(first.done, false);
    assert.ok(performance.now() - started < 150, "the first event must not wait for the second");
    assert.ok(new TextDecoder().decode(first.value).startsWith("data: first"));
    await reader.cancel();
  });

  test("streaming a body of many small frames preserves bytes and order", { skip: !isLocalHttpBase }, async () => {
    const count = 512;
    const size = 1024;
    const response = await wreqFetch(httpUrl(`/chunked/many?n=${count}&size=${size}`), {
      browser: "chrome_142",
      timeout: 10_000,
    });

    const reads: number[] = [];
    let offset = 0;
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      reads.push(chunk.byteLength);
      for (let i = 0; i < chunk.byteLength; i += 1) {
        const expected = Math.floor((offset + i) / size) & 0xff;
        if (chunk[i] !== expected) {
          assert.fail(`byte ${offset + i} was ${chunk[i]}, expected ${expected}`);
        }
      }
      offset += chunk.byteLength;
    }

    assert.strictEqual(offset, count * size, "every byte must arrive exactly once");
    // Frames that were already delivered natively are merged into one read, so the
    // client sees far fewer reads than the server wrote frames. Not asserted as an
    // exact count: it depends on timing, only on it being a real reduction.
    assert.ok(reads.length < count, `expected coalesced reads, got ${reads.length} for ${count} frames`);
  });
});
