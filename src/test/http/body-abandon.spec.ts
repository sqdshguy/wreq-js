import assert from "node:assert";
import { getEventListeners } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createSession, fetch } from "../../wreq-js.js";

// Cancelling or abandoning a response body with data still unread leaves the HTTP/1.1
// connection in the middle of a message. The native layer drains a small remainder
// (up to 256 KiB and 5 s) so the connection can go back to the pool, and
// drops the connection when more than that is left.
async function withSlowServer(
  chunks: number[],
  gapMs: number,
  run: (baseUrl: string, accepted: () => number) => Promise<void>,
  announceLength = false,
): Promise<void> {
  const sockets = new Set<Socket>();
  let accepted = 0;
  const server = createServer(async (_req, res) => {
    res.setHeader("Content-Type", "application/octet-stream");
    if (announceLength) {
      res.setHeader("Content-Length", String(chunks.reduce((sum, size) => sum + size, 0)));
    }
    for (let i = 0; i < chunks.length; i += 1) {
      res.write(Buffer.alloc(chunks[i] as number, i + 1));
      await delay(gapMs);
    }
    res.end();
  });
  server.on("connection", (socket: Socket) => {
    accepted += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, () => accepted);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("abandoned response bodies", () => {
  test("a small unread remainder is drained and the connection is reused", async () => {
    // 4 x 4 KiB with 20 ms gaps: at hand-off only the first chunk is in, 12 KiB remain.
    await withSlowServer([4096, 4096, 4096, 4096], 20, async (baseUrl, accepted) => {
      const session = await createSession();
      try {
        for (let i = 0; i < 6; i += 1) {
          const response = await session.fetch(`${baseUrl}/slow`, { timeout: 10_000 });
          assert.strictEqual(response.status, 200);
          assert.strictEqual(response.contentLength, null, "the body must be on the streaming path");
          await response.body?.cancel();
          // Give the drain time to finish before the next request wants the connection.
          await delay(120);
        }
        assert.strictEqual(accepted(), 1, "every request should have reused one connection");
      } finally {
        await session.close();
      }
    });
  });

  test("a large unread remainder drops the connection instead", async () => {
    // Chunked (no Content-Length, so the streaming path) with ~1 MiB still to come after
    // the first 4 KiB. That is far above the drain cap, so the body is dropped and hyper
    // closes the connection rather than draining it.
    const chunks = [4096, ...Array.from({ length: 8 }, () => 131072)];
    await withSlowServer(chunks, 20, async (baseUrl, accepted) => {
      const session = await createSession();
      try {
        for (let i = 0; i < 3; i += 1) {
          const response = await session.fetch(`${baseUrl}/slow`, { timeout: 10_000 });
          assert.strictEqual(response.status, 200);
          assert.strictEqual(response.contentLength, null, "the body must be on the streaming path");
          await response.body?.cancel();
          await delay(250);
        }
        assert.strictEqual(accepted(), 3, "each request should have needed a fresh connection");
      } finally {
        await session.close();
      }
    });
  });
});

// One connection that either streams forever ("endless") or sends one chunk and then
// goes quiet without ending the body ("stall"). Reports when the server saw it close.
async function withStreamingServer(
  mode: "endless" | "stall",
  run: (url: string, closedAt: () => number | undefined) => Promise<void>,
): Promise<void> {
  const sockets = new Set<Socket>();
  let closedAt: number | undefined;
  const chunk = Buffer.alloc(64 * 1024, 120);
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    if (mode === "stall") {
      res.write(chunk);
      return;
    }
    const pump = () => {
      while (res.write(chunk)) {}
      res.once("drain", pump);
    };
    pump();
  });
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      closedAt = Date.now();
      sockets.delete(socket);
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}/`, () => closedAt);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function waitForClose(closedAt: () => number | undefined, withinMs: number): Promise<number | undefined> {
  const deadline = Date.now() + withinMs;
  while (closedAt() === undefined && Date.now() < deadline) {
    await delay(10);
  }
  return closedAt();
}

describe("cancelled and aborted response bodies (#235)", () => {
  test("cancel() closes the connection right away when the rest is too large to drain", async () => {
    await withStreamingServer("endless", async (url, closedAt) => {
      const response = await fetch(url, { timeout: 10_000 });
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      await reader.read();
      const cancelledAt = Date.now();
      await reader.cancel();
      const closed = await waitForClose(closedAt, 2_000);
      assert.ok(closed !== undefined, "socket should close after cancel()");
      assert.ok(closed - cancelledAt < 1_000, `socket closed ${closed - cancelledAt} ms after cancel()`);
    });
  });

  test("a drain gives up after its deadline when the server goes quiet", async () => {
    await withStreamingServer("stall", async (url, closedAt) => {
      const response = await fetch(url, { timeout: 30_000 });
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      await reader.read();
      // A read already waiting on the quiet server returns as soon as the body is cancelled.
      const pending = reader.read();
      await delay(50);
      const cancelledAt = Date.now();
      await reader.cancel();
      assert.deepStrictEqual(await pending, { done: true, value: undefined });
      const closed = await waitForClose(closedAt, 8_000);
      assert.ok(closed !== undefined, "socket should close once the drain deadline passes");
      const elapsed = closed - cancelledAt;
      assert.ok(elapsed >= 4_000 && elapsed < 7_000, `socket closed ${elapsed} ms after cancel(), expected ~5 s`);
    });
  });

  test("aborting after fetch resolves errors a streaming body and closes the connection", async () => {
    await withStreamingServer("endless", async (url, closedAt) => {
      const controller = new AbortController();
      const response = await fetch(url, { timeout: 10_000, signal: controller.signal });
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      await reader.read();
      const abortedAt = Date.now();
      controller.abort();
      await assert.rejects(reader.read(), { name: "AbortError" });
      const closed = await waitForClose(closedAt, 2_000);
      assert.ok(closed !== undefined, "socket should close after abort");
      assert.ok(closed - abortedAt < 1_000, `socket closed ${closed - abortedAt} ms after abort`);
    });
  });

  test("aborting after fetch resolves rejects a pending text() at once", async () => {
    await withStreamingServer("stall", async (url) => {
      const controller = new AbortController();
      const response = await fetch(url, { timeout: 30_000, signal: controller.signal });
      const pending = response.text();
      await delay(50);
      const abortedAt = Date.now();
      controller.abort();
      await assert.rejects(pending, { name: "AbortError" });
      const elapsed = Date.now() - abortedAt;
      assert.ok(elapsed < 500, `text() rejected ${elapsed} ms after abort`);
    });
  });

  test("the abort listener is removed once the body has been read", async () => {
    await withSlowServer([4096, 4096], 20, async (baseUrl) => {
      const controller = new AbortController();
      const response = await fetch(`${baseUrl}/slow`, { timeout: 10_000, signal: controller.signal });
      assert.strictEqual(response.contentLength, null, "the body must be on the streaming path");
      assert.strictEqual(getEventListeners(controller.signal, "abort").length, 1);
      const body = await response.text();
      assert.strictEqual(body.length, 8192);
      assert.strictEqual(getEventListeners(controller.signal, "abort").length, 0);
      controller.abort();
    });
  });
});
