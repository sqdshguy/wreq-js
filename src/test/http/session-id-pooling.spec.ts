import assert from "node:assert";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { describe, test } from "node:test";
import { fetch as wreqFetch } from "../../wreq-js.js";

async function withCountingServer(run: (baseUrl: string, connections: () => number) => Promise<void>): Promise<void> {
  const sockets = new Set<Socket>();
  let accepted = 0;
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/plain");
    res.end("ok");
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

describe("sessionId request pooling", () => {
  test("repeated fetches with the same sessionId reuse connections", async () => {
    await withCountingServer(async (baseUrl, connections) => {
      const sessionId = `pooling-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const requests = 8;

      for (let i = 0; i < requests; i += 1) {
        const response = await wreqFetch(`${baseUrl}/ping`, { sessionId, cookieMode: "session", timeout: 10_000 });
        assert.strictEqual(await response.text(), "ok");
      }

      // Every request used to build a fresh client (and trust store), so each one
      // opened a new TCP connection. A cached per-session client reuses them.
      assert.ok(
        connections() < requests,
        `expected connection reuse, but ${connections()} connections were opened for ${requests} requests`,
      );
    });
  });

  test("different sessionIds do not share connections", async () => {
    await withCountingServer(async (baseUrl, connections) => {
      const a = `pooling-a-${Date.now()}`;
      const b = `pooling-b-${Date.now()}`;

      await (await wreqFetch(`${baseUrl}/a`, { sessionId: a, cookieMode: "session", timeout: 10_000 })).text();
      await (await wreqFetch(`${baseUrl}/b`, { sessionId: b, cookieMode: "session", timeout: 10_000 })).text();

      assert.strictEqual(connections(), 2, "each session id should get its own pooled client");
    });
  });
});
