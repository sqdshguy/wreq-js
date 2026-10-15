import assert from "node:assert";
import { getEventListeners } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fetch } from "../../wreq-js.js";

// Cancelling a response body, or aborting the request's signal after fetch() resolved,
// must release the connection right away (#235).

// One connection that either streams forever ("endless"), sends one chunk and then goes
// quiet without ending the body ("stall"), or sends two small chunks and ends ("short").
// Reports when the server saw the connection close.
async function withStreamingServer(
  mode: "endless" | "stall" | "short",
  run: (url: string, closedAt: () => number | undefined) => Promise<void>,
): Promise<void> {
  const sockets = new Set<Socket>();
  let closedAt: number | undefined;
  const chunk = Buffer.alloc(64 * 1024, 120);
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    if (mode === "stall") {
      // Small enough to arrive as a single frame, so the next read really waits.
      res.write(Buffer.alloc(4096, 3));
      return;
    }
    if (mode === "short") {
      res.write(Buffer.alloc(4096, 1));
      setTimeout(() => res.end(Buffer.alloc(4096, 2)), 20);
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
  test("cancel() closes the connection right away", async () => {
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

  test("cancel() closes the connection while a read is waiting on a quiet server", async () => {
    await withStreamingServer("stall", async (url, closedAt) => {
      const response = await fetch(url, { timeout: 30_000 });
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      await reader.read();
      const pending = reader.read();
      await delay(50);
      const cancelledAt = Date.now();
      await reader.cancel();
      assert.deepStrictEqual(await pending, { done: true, value: undefined });
      const closed = await waitForClose(closedAt, 2_000);
      assert.ok(closed !== undefined, "socket should close after cancel()");
      assert.ok(closed - cancelledAt < 1_000, `socket closed ${closed - cancelledAt} ms after cancel()`);
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
    await withStreamingServer("stall", async (url, closedAt) => {
      const controller = new AbortController();
      const response = await fetch(url, { timeout: 30_000, signal: controller.signal });
      const pending = response.text();
      await delay(50);
      const abortedAt = Date.now();
      controller.abort();
      await assert.rejects(pending, { name: "AbortError" });
      const elapsed = Date.now() - abortedAt;
      assert.ok(elapsed < 500, `text() rejected ${elapsed} ms after abort`);
      const closed = await waitForClose(closedAt, 2_000);
      assert.ok(closed !== undefined, "socket should close after abort");
    });
  });

  test("the abort listener is removed once the body has been read", async () => {
    await withStreamingServer("short", async (url) => {
      const controller = new AbortController();
      const response = await fetch(url, { timeout: 10_000, signal: controller.signal });
      assert.strictEqual(response.contentLength, null, "the body must be on the streaming path");
      assert.strictEqual(getEventListeners(controller.signal, "abort").length, 1);
      const body = await response.text();
      assert.strictEqual(body.length, 8192);
      assert.strictEqual(getEventListeners(controller.signal, "abort").length, 0);
      controller.abort();
    });
  });
});
