import assert from "node:assert";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createSecureServer, type ServerHttp2Session } from "node:http2";
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

  test("parallel ephemeral HTTP/2 requests keep connections, TLS, cookies, and authorization separate", async () => {
    const server = createSecureServer({
      key: readFileSync(resolve(CERTS_DIR, "self-signed.key")),
      cert: readFileSync(resolve(CERTS_DIR, "self-signed.crt")),
    });
    const sessions = new Set<ServerHttp2Session>();
    const resumed: boolean[] = [];
    server.on("session", (session) => sessions.add(session));
    server.on("secureConnection", (socket) => resumed.push(socket.isSessionReused()));
    server.on("stream", (stream, headers) => {
      stream.respond({ ":status": 200, "set-cookie": "identity=previous-request; Path=/" });
      stream.end(JSON.stringify({ cookie: headers.cookie ?? null, authorization: headers.authorization ?? null }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");

    try {
      // Two bursts exercise both a cold configuration and its cached client.
      for (let burst = 0; burst < 2; burst += 1) {
        await Promise.all(
          Array.from({ length: 16 }, async (_, index) => {
            const authorization = burst === 0 && index % 2 === 0 ? `Bearer request-${index}` : null;
            const response = await wreqFetch(`https://127.0.0.1:${address.port}/`, {
              browser: "chrome_142",
              os: "linux",
              insecure: true,
              timeout: 10_000,
              ...(authorization ? { headers: { authorization } } : {}),
            });
            assert.deepStrictEqual(await response.json(), { cookie: null, authorization });
          }),
        );
      }
      assert.strictEqual(sessions.size, 32, "every request needs its own HTTP/2 connection");
      assert.strictEqual(resumed.length, 32);
      assert.ok(
        resumed.every((value) => value === false),
        "TLS sessions must not resume across requests",
      );
    } finally {
      for (const session of sessions) session.destroy();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    }
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
