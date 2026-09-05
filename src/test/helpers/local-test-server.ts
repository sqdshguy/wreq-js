import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const WS_MAGIC_STRING = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const GZIP_RESPONSE = gzipSync(JSON.stringify({ message: "compressed", gzipped: true }));

const __dirname = dirname(fileURLToPath(import.meta.url));
const CERTS_DIR = resolve(__dirname, "certs");

export interface LocalTestServer {
  httpBaseUrl: string;
  wsUrl: string;
  httpsSelfSignedUrl: string;
  httpsExpiredUrl: string;
  httpsCustomCaUrl: string;
  close(): Promise<void>;
}

export async function startLocalTestServer(): Promise<LocalTestServer> {
  let baseUrl = "http://127.0.0.1";
  let selfSignedBaseUrl = "https://127.0.0.1";
  let expiredBaseUrl = "https://127.0.0.1";
  let customCaBaseUrl = "https://127.0.0.1";

  const sockets = new Set<Socket>();
  const hangingRequests = new Map<string, { closed: boolean }>();

  // Load certificates for HTTPS servers
  const selfSignedKey = readFileSync(resolve(CERTS_DIR, "self-signed.key"));
  const selfSignedCert = readFileSync(resolve(CERTS_DIR, "self-signed.crt"));
  const expiredKey = readFileSync(resolve(CERTS_DIR, "expired.key"));
  const expiredCert = readFileSync(resolve(CERTS_DIR, "expired.crt"));
  const customCaKey = readFileSync(resolve(CERTS_DIR, "default-paths-leaf.key"));
  const customCaCert = readFileSync(resolve(CERTS_DIR, "default-paths-leaf.crt"));

  const createRequestHandler = (getBaseUrl: () => string) => async (req: IncomingMessage, res: ServerResponse) => {
    try {
      await routeHttpRequest(req, res, getBaseUrl());
    } catch (error) {
      console.error("Local test server request error:", error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
      }
      res.end(JSON.stringify({ error: "internal server error" }));
    }
  };

  const trackSockets = (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {
      // Ignore connection-level errors during tests to avoid crashing the harness.
    });
  };

  // HTTP server
  const server = createServer(createRequestHandler(() => baseUrl));

  // HTTPS server with self-signed certificate
  const selfSignedServer = createHttpsServer(
    { key: selfSignedKey, cert: selfSignedCert },
    createRequestHandler(() => selfSignedBaseUrl),
  );

  // HTTPS server with expired certificate
  const expiredServer = createHttpsServer(
    { key: expiredKey, cert: expiredCert },
    createRequestHandler(() => expiredBaseUrl),
  );
  const customCaServer = createHttpsServer(
    { key: customCaKey, cert: customCaCert },
    createRequestHandler(() => customCaBaseUrl),
  );

  server.on("connection", trackSockets);
  selfSignedServer.on("connection", trackSockets);
  selfSignedServer.on("secureConnection", trackSockets);
  expiredServer.on("connection", trackSockets);
  expiredServer.on("secureConnection", trackSockets);
  customCaServer.on("connection", trackSockets);
  customCaServer.on("secureConnection", trackSockets);

  server.on("connect", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    // Respond with a simple JSON body to exercise CONNECT handling without tunneling.
    socket.on("error", () => {
      // Swallow errors; client may close the tunnel abruptly.
    });
    try {
      const payload = JSON.stringify({
        method: req.method ?? "CONNECT",
        target: req.url ?? "",
        headers: req.headers,
        headLength: head.length,
      });

      socket.write(
        [
          "HTTP/1.1 200 Connection Established",
          "Content-Type: application/json",
          `Content-Length: ${Buffer.byteLength(payload)}`,
          "Connection: close",
          "",
          "",
        ].join("\r\n"),
      );
      socket.write(payload);
    } catch (error) {
      console.error("Local test server CONNECT handler error:", error);
      socket.write("HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n");
    } finally {
      socket.end();
    }
  });

  server.on("upgrade", (req, socket: Socket, head) => {
    handleWebSocketUpgrade(req, socket, head);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: unknown) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });

  const address = server.address() as AddressInfo | null;
  if (!address) {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    throw new Error("Unable to determine local test server address");
  }

  baseUrl = `http://127.0.0.1:${address.port}`;
  const wsUrl = `ws://127.0.0.1:${address.port}/ws`;

  // Start HTTPS server with self-signed certificate
  await new Promise<void>((resolve, reject) => {
    const onError = (error: unknown) => {
      selfSignedServer.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      selfSignedServer.off("error", onError);
      resolve();
    };

    selfSignedServer.once("error", onError);
    selfSignedServer.once("listening", onListening);
    selfSignedServer.listen(0, "127.0.0.1");
  });

  const selfSignedAddress = selfSignedServer.address() as AddressInfo | null;
  if (!selfSignedAddress) {
    throw new Error("Unable to determine self-signed HTTPS server address");
  }
  selfSignedBaseUrl = `https://127.0.0.1:${selfSignedAddress.port}`;

  // Start HTTPS server with expired certificate
  await new Promise<void>((resolve, reject) => {
    const onError = (error: unknown) => {
      expiredServer.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      expiredServer.off("error", onError);
      resolve();
    };

    expiredServer.once("error", onError);
    expiredServer.once("listening", onListening);
    expiredServer.listen(0, "127.0.0.1");
  });

  const expiredAddress = expiredServer.address() as AddressInfo | null;
  if (!expiredAddress) {
    throw new Error("Unable to determine expired HTTPS server address");
  }
  expiredBaseUrl = `https://127.0.0.1:${expiredAddress.port}`;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: unknown) => {
      customCaServer.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      customCaServer.off("error", onError);
      resolve();
    };

    customCaServer.once("error", onError);
    customCaServer.once("listening", onListening);
    customCaServer.listen(0, "127.0.0.1");
  });

  const customCaAddress = customCaServer.address() as AddressInfo | null;
  if (!customCaAddress) {
    throw new Error("Unable to determine custom CA HTTPS server address");
  }
  customCaBaseUrl = `https://127.0.0.1:${customCaAddress.port}`;

  const close = async () => {
    for (const socket of sockets) {
      socket.destroy();
    }

    await Promise.all([
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
      new Promise<void>((resolve, reject) => {
        selfSignedServer.close((error) => (error ? reject(error) : resolve()));
      }),
      new Promise<void>((resolve, reject) => {
        expiredServer.close((error) => (error ? reject(error) : resolve()));
      }),
      new Promise<void>((resolve, reject) => {
        customCaServer.close((error) => (error ? reject(error) : resolve()));
      }),
    ]);
  };

  return {
    httpBaseUrl: baseUrl,
    wsUrl,
    httpsSelfSignedUrl: selfSignedBaseUrl,
    httpsExpiredUrl: expiredBaseUrl,
    httpsCustomCaUrl: customCaBaseUrl,
    close,
  };

  async function routeHttpRequest(req: IncomingMessage, res: ServerResponse, resolvedBase: string) {
    const url = new URL(req.url ?? "/", resolvedBase);
    const path = url.pathname;

    if (path === "/get") {
      return json(res, createEchoPayload(req, url));
    }

    if (path === "/json") {
      return json(res, {
        message: "local test server",
        status: "ok",
        ts: Date.now(),
      });
    }

    if (path === "/user-agent") {
      return json(res, { "user-agent": req.headers["user-agent"] ?? "" });
    }

    if (path === "/headers") {
      return json(res, {
        headers: canonicalizeHeaders(req),
        rawHeaders: req.rawHeaders,
      });
    }

    if (path === "/gzip") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Encoding", "gzip");
      res.setHeader("Content-Length", GZIP_RESPONSE.length);
      res.end(GZIP_RESPONSE);
      return;
    }

    if (req.method === "TRACE") {
      return json(res, {
        method: req.method,
        path,
        headers: canonicalizeHeaders(req),
      });
    }

    if (path === "/echo-body") {
      const chunks: Buffer[] = [];

      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }

      const received = Buffer.concat(chunks);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", received.length);
      res.end(received);
      return;
    }

    if (path === "/binary") {
      const lengthParam = url.searchParams.get("len");
      const length =
        Number.isFinite(Number(lengthParam)) && Number(lengthParam) > 0 ? Math.min(Number(lengthParam), 4096) : 256;

      const payload = Buffer.alloc(length);

      for (let i = 0; i < length; i += 1) {
        payload[i] = i % 256;
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", payload.length);
      res.end(payload);
      return;
    }

    if (path === "/stream/chunks") {
      const chunkCount = Math.max(1, Math.min(Number(url.searchParams.get("n") ?? "3"), 16));
      const chunkSize = Math.max(1, Math.min(Number(url.searchParams.get("size") ?? "1024"), 65536));

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/octet-stream");

      for (let i = 0; i < chunkCount; i += 1) {
        const chunk = Buffer.alloc(chunkSize, i);
        res.write(chunk);
        await delay(5);
      }

      res.end();
      return;
    }

    if (path === "/stream/slow") {
      // First chunk immediately, second after a pause long enough to outlast the
      // native inline window, so the body must be delivered as a stream.
      const gapMs = Math.max(1, Math.min(Number(url.searchParams.get("gap") ?? "200"), 5000));
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/octet-stream");
      res.write(Buffer.alloc(256, 1));
      await delay(gapMs);
      res.write(Buffer.alloc(256, 2));
      res.end();
      return;
    }

    if (path === "/sse") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.write("data: first\n\n");
      await delay(200);
      res.write("data: second\n\n");
      res.end();
      return;
    }

    if (path === "/cookies") {
      return json(res, { cookies: parseCookies(req.headers.cookie) });
    }

    if (path.startsWith("/cookies/set")) {
      const cookiesToSet = Array.from(url.searchParams.entries()).map(([key, value]) => `${key}=${value}; Path=/`);
      const existingCookies = parseCookies(req.headers.cookie);
      const newCookies = Object.fromEntries(url.searchParams.entries()) as Record<string, string>;

      if (cookiesToSet.length > 0) {
        res.setHeader("Set-Cookie", cookiesToSet);
      }
      return json(res, { cookies: { ...existingCookies, ...newCookies } });
    }

    if (path === "/redirect") {
      res.statusCode = 302;
      res.setHeader("Location", `${resolvedBase}/json`);
      res.end();
      return;
    }

    const delayMatch = path.match(/^\/delay\/(\d+)/);
    if (delayMatch) {
      const seconds = Number(delayMatch[1]);
      await delay(seconds * 1000);
      return json(res, { delayed: seconds, ...createEchoPayload(req, url) });
    }

    if (path === "/hang") {
      const id = url.searchParams.get("id");

      if (!id) {
        res.statusCode = 400;
        return json(res, { error: "id query param required" });
      }

      const state = { closed: false };
      hangingRequests.set(id, state);

      const markClosed = () => {
        state.closed = true;
      };

      req.socket.on("close", markClosed);
      req.socket.on("error", markClosed);
      return;
    }

    if (path === "/hang/status") {
      const id = url.searchParams.get("id");

      if (!id) {
        res.statusCode = 400;
        return json(res, { error: "id query param required" });
      }

      const closed = hangingRequests.get(id)?.closed ?? false;
      hangingRequests.delete(id);
      return json(res, { closed });
    }

    res.statusCode = 404;
    json(res, { error: "not found", path });
  }

  function createEchoPayload(req: IncomingMessage, url: URL) {
    const args = Object.fromEntries(url.searchParams.entries()) as Record<string, string>;

    return {
      args,
      headers: canonicalizeHeaders(req),
      method: req.method ?? "GET",
      origin: req.socket.remoteAddress ?? "127.0.0.1",
      url: url.toString(),
    };
  }

  function canonicalizeHeaders(req: IncomingMessage) {
    const headers: Record<string, string> = {};

    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "undefined") continue;
      const canonicalName = name
        .split("-")
        .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
        .join("-");
      headers[canonicalName] = Array.isArray(value) ? value.join(", ") : value;
    }

    return headers;
  }

  function parseCookies(cookieHeader: string | undefined) {
    if (!cookieHeader) {
      return {};
    }

    return cookieHeader.split(";").reduce<Record<string, string>>((acc, cookie) => {
      const [key, ...rest] = cookie.trim().split("=");
      if (!key) {
        return acc;
      }
      acc[key] = rest.join("=");
      return acc;
    }, {});
  }

  function json(res: ServerResponse, body: unknown) {
    if (!res.hasHeader("Content-Type")) {
      res.setHeader("Content-Type", "application/json");
    }
    res.end(JSON.stringify(body));
  }

  function handleWebSocketUpgrade(req: IncomingMessage, socket: Socket, head: Buffer) {
    try {
      const url = new URL(req.url ?? "/", baseUrl);
      if (url.pathname !== "/ws") {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }

      const secKey = req.headers["sec-websocket-key"];
      if (!secKey || Array.isArray(secKey)) {
        socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }

      const acceptKey = createHash("sha1")
        .update(secKey + WS_MAGIC_STRING)
        .digest("base64");
      const requestedProtocolsRaw = req.headers["sec-websocket-protocol"] as string | string[] | undefined;
      const requestedProtocols =
        typeof requestedProtocolsRaw === "string"
          ? requestedProtocolsRaw
              .split(",")
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0)
          : Array.isArray(requestedProtocolsRaw)
            ? requestedProtocolsRaw
                .flatMap((entry) => entry.split(","))
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0)
            : [];
      const requiredProtocol = url.searchParams.get("requireProtocol");

      if (requiredProtocol && !requestedProtocols.includes(requiredProtocol)) {
        socket.write("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }

      const selectedProtocolFromQuery = url.searchParams.get("selectProtocol");
      const selectedProtocol =
        selectedProtocolFromQuery ??
        (requiredProtocol && requestedProtocols.includes(requiredProtocol) ? requiredProtocol : undefined);
      const responseHeaders = [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${acceptKey}`,
      ];
      if (selectedProtocol) {
        responseHeaders.push(`Sec-WebSocket-Protocol: ${selectedProtocol}`);
      }

      socket.write(`${responseHeaders.join("\r\n")}\r\n\r\n`);

      if (head.length > 0) {
        socket.unshift(head);
      }

      const closeCodeRaw = url.searchParams.get("closeCode");
      const closeReason = url.searchParams.get("closeReason") ?? "";
      let serverClose: { code: number; reason: string } | undefined;

      if (closeCodeRaw !== null) {
        const parsedCode = Number(closeCodeRaw);
        if (Number.isInteger(parsedCode) && parsedCode >= 1000 && parsedCode <= 4999) {
          serverClose = { code: parsedCode, reason: closeReason };
        }
      }

      const echoCookie = url.searchParams.get("echoCookie") === "1";
      const welcomeText = echoCookie ? `cookie:${req.headers.cookie ?? ""}` : undefined;
      const largeFrameBytesRaw = url.searchParams.get("largeFrameBytes");
      const largeFrameBinary = url.searchParams.get("largeFrameBinary") === "1";
      const largeFrameBytes =
        largeFrameBytesRaw !== null &&
        Number.isSafeInteger(Number(largeFrameBytesRaw)) &&
        Number(largeFrameBytesRaw) > 0
          ? Number(largeFrameBytesRaw)
          : undefined;

      setupEchoWebSocket(socket, serverClose, welcomeText, largeFrameBytes, largeFrameBinary);
    } catch (error) {
      console.error("Local test server WebSocket upgrade error:", error);
      socket.destroy();
    }
  }
}

function setupEchoWebSocket(
  socket: Socket,
  serverClose?: { code: number; reason: string },
  welcomeText?: string,
  largeFrameBytes?: number,
  largeFrameBinary = false,
) {
  let buffer = Buffer.alloc(0);
  let closed = false;

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    parseFrames();
  });

  socket.on("close", () => {
    closed = true;
  });

  socket.on("error", () => {
    socket.destroy();
  });

  if (serverClose) {
    const reasonBytes = Buffer.from(serverClose.reason, "utf8");
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(serverClose.code, 0);
    reasonBytes.copy(payload, 2);
    sendFrame(0x8, payload);
    closed = true;
    socket.end();
    return;
  }

  if (welcomeText !== undefined) {
    sendFrame(0x1, Buffer.from(welcomeText, "utf8"));
  }

  if (largeFrameBytes !== undefined) {
    const payload = Buffer.alloc(largeFrameBytes, largeFrameBinary ? 0xab : 0x78);
    sendFrame(largeFrameBinary ? 0x2 : 0x1, payload);
  }

  function parseFrames() {
    while (buffer.length >= 2) {
      const firstByte = buffer[0] as number;
      const secondByte = buffer[1] as number;

      const opcode = firstByte & 0x0f;
      const isMasked = Boolean(secondByte & 0x80);

      let offset = 2;
      let payloadLength = secondByte & 0x7f;

      if (payloadLength === 126) {
        if (buffer.length < offset + 2) return;
        payloadLength = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        if (buffer.length < offset + 8) return;
        const bigLength = buffer.readBigUInt64BE(offset);
        payloadLength = Number(bigLength);
        offset += 8;
      }

      const maskEnd = offset + (isMasked ? 4 : 0);
      if (buffer.length < maskEnd) return;

      const maskingKey = isMasked ? buffer.subarray(offset, maskEnd) : undefined;
      offset = maskEnd;

      const frameEnd = offset + payloadLength;
      if (buffer.length < frameEnd) return;

      const payload = buffer.subarray(offset, frameEnd);
      buffer = buffer.subarray(frameEnd);

      const data = isMasked && maskingKey ? unmask(payload, maskingKey) : payload;
      handleFrame(opcode, data);
    }
  }

  function handleFrame(opcode: number, data: Buffer) {
    if (closed) {
      return;
    }

    switch (opcode) {
      case 0x1: {
        // Text frame: echo payload back
        sendFrame(0x1, data);
        break;
      }
      case 0x2: {
        // Binary frame: echo back
        sendFrame(0x2, data);
        break;
      }
      case 0x8: {
        // Close frame
        sendFrame(0x8, data);
        closed = true;
        socket.end();
        break;
      }
      case 0x9: {
        // Ping
        sendFrame(0xa, data);
        break;
      }
      case 0xa: {
        // Pong - ignore
        break;
      }
      default: {
        // Unsupported opcode: close connection
        sendFrame(0x8, Buffer.alloc(0));
        closed = true;
        socket.end();
      }
    }
  }

  function sendFrame(opcode: number, data: Buffer) {
    const payloadLength = data.length;
    let headerLength = 2;
    if (payloadLength >= 126 && payloadLength < 65536) {
      headerLength += 2;
    } else if (payloadLength >= 65536) {
      headerLength += 8;
    }

    const frame = Buffer.alloc(headerLength + payloadLength);
    frame[0] = 0x80 | (opcode & 0x0f);

    let offset = 2;
    if (payloadLength < 126) {
      frame[1] = payloadLength;
    } else if (payloadLength < 65536) {
      frame[1] = 126;
      frame.writeUInt16BE(payloadLength, offset);
      offset += 2;
    } else {
      frame[1] = 127;
      frame.writeBigUInt64BE(BigInt(payloadLength), offset);
      offset += 8;
    }

    data.copy(frame, offset);
    socket.write(frame);
  }

  function unmask(payload: Buffer, maskingKey: Buffer) {
    const result = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) {
      const maskByte = maskingKey[i % 4] as number;
      result[i] = (payload[i] as number) ^ maskByte;
    }
    return result;
  }
}
