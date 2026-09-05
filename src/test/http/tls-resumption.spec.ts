import assert from "node:assert";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { dirname, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTransport, fetch as wreqFetch } from "../../wreq-js.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CERTS_DIR = resolve(__dirname, "../helpers/certs");

describe("TLS session resumption", () => {
  test("default fetch does not resume TLS sessions across cached ephemeral clients", async () => {
    const key = readFileSync(resolve(CERTS_DIR, "self-signed.key"));
    const cert = readFileSync(resolve(CERTS_DIR, "self-signed.crt"));
    const reusedSessions: boolean[] = [];

    const server = createHttpsServer({ key, cert }, (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    server.on("secureConnection", (socket) => {
      reusedSessions.push(socket.isSessionReused());
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to determine HTTPS test server address");
    }

    try {
      const url = `https://127.0.0.1:${address.port}/json`;

      for (let index = 0; index < 6; index += 1) {
        const response = await wreqFetch(url, {
          browser: "chrome_142",
          timeout: 10_000,
          insecure: true,
        });

        await response.arrayBuffer();
      }
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    }

    assert.strictEqual(reusedSessions.length, 6, "Each request should establish a fresh TLS connection");
    assert.ok(
      reusedSessions.every((reused) => reused === false),
      `Expected no TLS session resumption, saw: ${JSON.stringify(reusedSessions)}`,
    );
  });

  test("explicit transports still allow TLS session resumption when reconnecting", async () => {
    const key = readFileSync(resolve(CERTS_DIR, "self-signed.key"));
    const cert = readFileSync(resolve(CERTS_DIR, "self-signed.crt"));
    const reusedSessions: boolean[] = [];

    const server = createHttpsServer({ key, cert }, (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    server.on("secureConnection", (socket) => {
      reusedSessions.push(socket.isSessionReused());
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to determine HTTPS test server address");
    }

    const transport = await createTransport({
      browser: "chrome_142",
      insecure: true,
      poolMaxIdlePerHost: 0,
    });

    try {
      const url = `https://127.0.0.1:${address.port}/json`;

      for (let index = 0; index < 6; index += 1) {
        const response = await wreqFetch(url, {
          transport,
          timeout: 10_000,
        });

        await response.arrayBuffer();
      }
    } finally {
      await transport.close();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    }

    assert.strictEqual(reusedSessions.length, 6, "Each request should establish a fresh TLS connection");
    assert.ok(
      reusedSessions.some((reused) => reused),
      `Expected explicit transports to retain TLS resumption, saw: ${JSON.stringify(reusedSessions)}`,
    );
  });
});
