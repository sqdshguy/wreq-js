import assert from "node:assert";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { describe, test } from "node:test";
import { setImmediate as nextTick, setTimeout as delay } from "node:timers/promises";
import { createTransport, fetch as wreqFetch } from "../../wreq-js.js";

const forceGc = (globalThis as { gc?: () => void }).gc;

// A transport's pooled keep-alive connection stays open on the server for as long as
// the native client exists, so the server's open-socket count shows whether the
// native transport was released.
async function withCountingServer(run: (baseUrl: string, openSockets: () => number) => Promise<void>): Promise<void> {
  const sockets = new Set<Socket>();
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/plain");
    res.end("ok");
  });
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  try {
    await run(`http://127.0.0.1:${port}`, () => sockets.size);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function settled(openSockets: () => number, expected: number): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (openSockets() === expected) return true;
    await delay(10);
  }
  return openSockets() === expected;
}

describe("transport lifetime", () => {
  test("close() drops the pooled connection", async () => {
    await withCountingServer(async (baseUrl, openSockets) => {
      const transport = await createTransport();
      await (await wreqFetch(`${baseUrl}/ping`, { transport, timeout: 10_000 })).text();
      assert.ok(await settled(openSockets, 1), "one keep-alive connection should be open");

      await transport.close();
      assert.ok(await settled(openSockets, 0), "closing the transport should close its connection");
    });
  });

  test("an unreferenced Transport releases its native client when garbage collected", {
    skip: typeof forceGc !== "function",
  }, async () => {
    await withCountingServer(async (baseUrl, openSockets) => {
      // Scope the Transport so nothing holds it once this function returns.
      await (async () => {
        const transport = await createTransport();
        await (await wreqFetch(`${baseUrl}/ping`, { transport, timeout: 10_000 })).text();
      })();
      assert.ok(await settled(openSockets, 1), "the pooled connection should still be open");

      let released = false;
      for (let attempt = 0; attempt < 50 && !released; attempt += 1) {
        forceGc?.();
        await nextTick();
        await nextTick();
        await delay(10);
        released = openSockets() === 0;
      }

      assert.ok(released, "the finalizer should have dropped the transport and its connection");
    });
  });
});
