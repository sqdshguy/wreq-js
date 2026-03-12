import assert from "node:assert";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import { createSession, createTransport, RequestError, fetch as wreqFetch } from "../../wreq-js.js";
import { httpUrl } from "../helpers/http.js";

describe("Transport API", () => {
  test("creates and closes transports", async () => {
    const transport = await createTransport({ browser: "chrome_142" });
    assert.strictEqual(transport.closed, false);

    await transport.close();
    assert.strictEqual(transport.closed, true);
    await transport.close();
  });

  test("uses an explicit transport for stateless fetch", async () => {
    const transport = await createTransport({ browser: "chrome_142" });

    try {
      const response = await wreqFetch(httpUrl("/get"), {
        transport,
        timeout: 10_000,
      });

      assert.strictEqual(response.status, 200);
    } finally {
      await transport.close();
    }
  });

  test("routes requests through a real HTTP proxy", async () => {
    const proxiedRequests: string[] = [];
    const proxyServer = createServer((req, res) => {
      proxiedRequests.push(req.url ?? "");

      let target: URL;
      try {
        if (req.url && /^https?:\/\//i.test(req.url)) {
          target = new URL(req.url);
        } else {
          const host = req.headers.host;
          if (!host) {
            res.statusCode = 400;
            res.end("Missing Host header");
            return;
          }
          target = new URL(req.url ?? "/", `http://${host}`);
        }
      } catch (error) {
        res.statusCode = 400;
        res.end(String(error));
        return;
      }

      const upstream = httpRequest(
        target,
        {
          method: req.method,
          headers: req.headers,
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );

      upstream.on("error", (error) => {
        if (!res.headersSent) {
          res.statusCode = 502;
        }
        res.end(String(error));
      });

      req.pipe(upstream);
    });

    await new Promise<void>((resolve, reject) => {
      proxyServer.once("error", reject);
      proxyServer.listen(0, "127.0.0.1", () => {
        proxyServer.off("error", reject);
        resolve();
      });
    });

    const address = proxyServer.address() as AddressInfo | null;
    if (!address) {
      await new Promise<void>((resolve, reject) => proxyServer.close((error) => (error ? reject(error) : resolve())));
      throw new Error("Failed to determine proxy server address");
    }

    const transport = await createTransport({
      browser: "chrome_142",
      proxy: `http://127.0.0.1:${address.port}`,
    });

    try {
      const response = await wreqFetch(httpUrl("/get"), {
        transport,
        timeout: 10_000,
      });

      assert.strictEqual(response.status, 200);
      assert.ok(
        proxiedRequests.some((url) => url.includes("/get")),
        "Proxy should observe proxied request URL",
      );
    } finally {
      await transport.close();
      await new Promise<void>((resolve, reject) => proxyServer.close((error) => (error ? reject(error) : resolve())));
    }
  });

  test("rejects closed transports", async () => {
    const transport = await createTransport({ browser: "chrome_142" });
    await transport.close();

    await assert.rejects(
      wreqFetch(httpUrl("/get"), { transport, timeout: 10_000 }),
      (error: unknown) => error instanceof RequestError && /Transport has been closed/.test(error.message),
    );
  });

  test("rejects transport with browser/os/emulation/proxy/insecure overrides", async () => {
    const transport = await createTransport({ browser: "chrome_142" });

    try {
      const okResponse = await wreqFetch(httpUrl("/get"), {
        transport,
        proxy: undefined,
        timeout: 10_000,
      } as never);
      assert.strictEqual(okResponse.status, 200);

      await assert.rejects(
        wreqFetch(httpUrl("/get"), { transport, browser: "chrome_142" }),
        (error: unknown) =>
          error instanceof RequestError &&
          /cannot be combined with browser\/os\/emulation\/proxy\/insecure/.test(error.message),
      );

      await assert.rejects(
        wreqFetch(httpUrl("/get"), { transport, os: "linux" }),
        (error: unknown) =>
          error instanceof RequestError &&
          /cannot be combined with browser\/os\/emulation\/proxy\/insecure/.test(error.message),
      );

      await assert.rejects(
        wreqFetch(httpUrl("/get"), { transport, emulation: { headers: { "X-Test": "alpha" } } }),
        (error: unknown) =>
          error instanceof RequestError &&
          /cannot be combined with browser\/os\/emulation\/proxy\/insecure/.test(error.message),
      );

      await assert.rejects(
        wreqFetch(httpUrl("/get"), { transport, proxy: "http://proxy.example.com:8080" }),
        (error: unknown) =>
          error instanceof RequestError &&
          /cannot be combined with browser\/os\/emulation\/proxy\/insecure/.test(error.message),
      );

      await assert.rejects(
        wreqFetch(httpUrl("/get"), { transport, insecure: true }),
        (error: unknown) =>
          error instanceof RequestError &&
          /cannot be combined with browser\/os\/emulation\/proxy\/insecure/.test(error.message),
      );
    } finally {
      await transport.close();
    }
  });

  test("rejects invalid pool configuration values", async () => {
    await assert.rejects(
      createTransport({ poolIdleTimeout: -1 }),
      (error: unknown) => error instanceof RequestError && /poolIdleTimeout must be greater than 0/.test(error.message),
    );

    await assert.rejects(
      createTransport({ poolMaxIdlePerHost: -1 }),
      (error: unknown) =>
        error instanceof RequestError && /poolMaxIdlePerHost must be greater than or equal to 0/.test(error.message),
    );

    await assert.rejects(
      createTransport({ poolMaxIdlePerHost: 1.5 }),
      (error: unknown) => error instanceof RequestError && /poolMaxIdlePerHost must be an integer/.test(error.message),
    );

    await assert.rejects(
      createTransport({ poolMaxSize: 0 }),
      (error: unknown) => error instanceof RequestError && /poolMaxSize must be greater than 0/.test(error.message),
    );

    await assert.rejects(
      createTransport({ poolMaxSize: 1.5 }),
      (error: unknown) => error instanceof RequestError && /poolMaxSize must be an integer/.test(error.message),
    );

    await assert.rejects(
      createTransport({ connectTimeout: 0 }),
      (error: unknown) => error instanceof RequestError && /connectTimeout must be greater than 0/.test(error.message),
    );

    await assert.rejects(
      createTransport({ readTimeout: Number.NaN }),
      (error: unknown) => error instanceof RequestError && /readTimeout must be a finite number/.test(error.message),
    );
  });

  test("surfaces transport creation failures", async () => {
    await assert.rejects(
      createTransport({ proxy: "http://" }),
      (error: unknown) => error instanceof RequestError && /Failed to create proxy/.test(error.message),
    );
  });

  test("isolates cookies across sessions sharing a transport", async () => {
    const transport = await createTransport({ browser: "chrome_142" });
    const sessionA = await createSession();
    const sessionB = await createSession();

    try {
      await sessionA.fetch(httpUrl("/cookies/set?flavor=alpha"), { transport, timeout: 10_000 });
      await sessionB.fetch(httpUrl("/cookies/set?flavor=beta"), { transport, timeout: 10_000 });

      const cookiesA = await sessionA.fetch(httpUrl("/cookies"), { transport, timeout: 10_000 });
      const cookiesB = await sessionB.fetch(httpUrl("/cookies"), { transport, timeout: 10_000 });

      const bodyA = await cookiesA.json<{ cookies: Record<string, string> }>();
      const bodyB = await cookiesB.json<{ cookies: Record<string, string> }>();

      assert.strictEqual(bodyA.cookies.flavor, "alpha");
      assert.strictEqual(bodyB.cookies.flavor, "beta");
    } finally {
      await sessionA.close();
      await sessionB.close();
      await transport.close();
    }
  });

  test("applies session default headers", async () => {
    const session = await createSession({
      defaultHeaders: { "X-Session": "alpha" },
    });

    try {
      const response = await session.fetch(httpUrl("/headers"), { timeout: 10_000 });
      const body = await response.json<{ headers: Record<string, string> }>();
      assert.strictEqual(body.headers["X-Session"], "alpha");

      const override = await session.fetch(httpUrl("/headers"), {
        headers: { "X-Session": "beta" },
        timeout: 10_000,
      });
      const overrideBody = await override.json<{ headers: Record<string, string> }>();
      assert.strictEqual(overrideBody.headers["X-Session"], "beta");
    } finally {
      await session.close();
    }
  });

  test("createTransport({ emulation }) works without browser/os and can be reused", async () => {
    const transport = await createTransport({
      emulation: {
        headers: {
          "User-Agent": "Standalone Transport/1.0",
          "X-Transport-Emulation": "alpha",
        },
      },
    });

    try {
      const first = await wreqFetch(httpUrl("/headers"), { transport, timeout: 10_000 });
      const second = await wreqFetch(httpUrl("/headers"), { transport, timeout: 10_000 });

      const firstBody = await first.json<{ headers: Record<string, string> }>();
      const secondBody = await second.json<{ headers: Record<string, string> }>();

      assert.strictEqual(firstBody.headers["User-Agent"], "Standalone Transport/1.0");
      assert.strictEqual(firstBody.headers["X-Transport-Emulation"], "alpha");
      assert.strictEqual(secondBody.headers["User-Agent"], "Standalone Transport/1.0");
      assert.strictEqual(secondBody.headers["X-Transport-Emulation"], "alpha");
    } finally {
      await transport.close();
    }
  });
});
