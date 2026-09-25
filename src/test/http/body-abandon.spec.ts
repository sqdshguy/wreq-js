import assert from "node:assert";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createSession } from "../../wreq-js.js";

// Cancelling or abandoning a response body with data still unread leaves the HTTP/1.1
// connection in the middle of a message. The native layer drains a small remainder
// (up to 128 KiB, undici's dump() cap) so the connection can go back to the pool, and
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
