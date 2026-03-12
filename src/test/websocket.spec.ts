import assert from "node:assert";
import { before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createSession,
  RequestError,
  type WebSocketCloseEvent,
  type WebSocketMessageEvent,
  Headers as WreqHeaders,
  WebSocket as WreqWebSocket,
  websocket,
} from "../wreq-js.js";
import { httpUrl } from "./helpers/http.js";

const WS_TEST_URL = process.env.WS_TEST_URL;

if (!WS_TEST_URL) {
  throw new Error("WS_TEST_URL environment variable must be set by the test runner");
}

function dataToString(data: string | Buffer | ArrayBuffer | Blob): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    throw new TypeError("Blob payload requires async conversion");
  }
  throw new TypeError("Unsupported WebSocket message payload type");
}

function waitForOpen(ws: WreqWebSocket, timeoutMs = 2_000): Promise<void> {
  if (ws.readyState === WreqWebSocket.OPEN) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      reject(new Error("Timed out waiting for open event"));
    }, timeoutMs);

    const onOpen = () => {
      clearTimeout(timer);
      ws.removeEventListener("error", onError);
      resolve();
    };

    const onError = () => {
      clearTimeout(timer);
      ws.removeEventListener("open", onOpen);
      reject(new Error("WebSocket emitted error before open"));
    };

    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
  });
}

function waitForClose(ws: WreqWebSocket, timeoutMs = 2_000): Promise<WebSocketCloseEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("close", onClose);
      reject(new Error("Timed out waiting for close event"));
    }, timeoutMs);

    const onClose = (event: WebSocketCloseEvent) => {
      clearTimeout(timer);
      resolve(event);
    };

    ws.addEventListener("close", onClose);
  });
}

function waitForMessage(ws: WreqWebSocket, timeoutMs = 2_000): Promise<WebSocketMessageEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error("Timed out waiting for message event"));
    }, timeoutMs);

    const onMessage = (event: WebSocketMessageEvent) => {
      clearTimeout(timer);
      resolve(event);
    };

    ws.addEventListener("message", onMessage);
  });
}

describe("WebSocket", () => {
  before(() => {
    console.log("🔌 WebSocket Test Suite\n");
  });

  test("constructor is drop-in style and transitions CONNECTING -> OPEN", async () => {
    const ws = new WreqWebSocket(WS_TEST_URL, { browser: "chrome_142" });
    assert.strictEqual(ws.readyState, WreqWebSocket.CONNECTING);

    await waitForOpen(ws);
    assert.strictEqual(ws.readyState, WreqWebSocket.OPEN);

    ws.close();
    await waitForClose(ws);
  });

  test("constructor supports standalone custom emulation without browser/os", async () => {
    const ws = new WreqWebSocket(WS_TEST_URL, {
      emulation: {
        headers: {
          "User-Agent": "Standalone WS Constructor/1.0",
        },
      },
    });

    await waitForOpen(ws);

    const messagePromise = waitForMessage(ws);
    await ws.send("standalone-constructor");
    assert.strictEqual(dataToString((await messagePromise).data), "standalone-constructor");

    ws.close();
    await waitForClose(ws);
  });

  test("constructor supports protocols overload syntax", async () => {
    const url = new URL(WS_TEST_URL);
    url.searchParams.set("requireProtocol", "chat");

    const wsWithProtocolString = new WreqWebSocket(url, "chat");
    await waitForOpen(wsWithProtocolString);
    assert.strictEqual(wsWithProtocolString.protocol, "chat");

    const stringProtocolMessage = waitForMessage(wsWithProtocolString);
    await wsWithProtocolString.send("proto-string");
    assert.strictEqual(dataToString((await stringProtocolMessage).data), "proto-string");

    wsWithProtocolString.close();
    await waitForClose(wsWithProtocolString);

    const wsWithProtocolsAndOptions = new WreqWebSocket(url, ["chat", "superchat"], { browser: "chrome_142" });
    await waitForOpen(wsWithProtocolsAndOptions);
    assert.strictEqual(wsWithProtocolsAndOptions.protocol, "chat");

    const listProtocolMessage = waitForMessage(wsWithProtocolsAndOptions);
    await wsWithProtocolsAndOptions.send("proto-list");
    assert.strictEqual(dataToString((await listProtocolMessage).data), "proto-list");

    wsWithProtocolsAndOptions.close();
    await waitForClose(wsWithProtocolsAndOptions);
  });

  test("sends protocols in handshake and exposes selected protocol", async () => {
    const url = new URL(WS_TEST_URL);
    url.searchParams.set("requireProtocol", "chat");

    const ws = await websocket(url, {
      browser: "chrome_142",
      protocols: ["chat", "superchat"],
    });

    assert.strictEqual(ws.protocol, "chat");

    const messagePromise = waitForMessage(ws);
    await ws.send("protocol-ok");
    assert.strictEqual(dataToString((await messagePromise).data), "protocol-ok");

    ws.close();
    await waitForClose(ws);
  });

  test("fails handshake when required protocol is missing", async () => {
    const url = new URL(WS_TEST_URL);
    url.searchParams.set("requireProtocol", "chat");

    await assert.rejects(websocket(url, { browser: "chrome_142" }), (error: unknown) => error instanceof RequestError);
  });

  test("rejects manual Sec-WebSocket-Protocol header when protocols option is used", async () => {
    await assert.rejects(
      websocket(WS_TEST_URL, {
        browser: "chrome_142",
        protocols: "chat",
        headers: { "Sec-WebSocket-Protocol": "chat" },
      }),
      (error: unknown) =>
        error instanceof RequestError && /Do not set `Sec-WebSocket-Protocol` header manually/.test(error.message),
    );
  });

  test("rejects duplicate protocol values", async () => {
    await assert.rejects(
      websocket(WS_TEST_URL, {
        browser: "chrome_142",
        protocols: ["chat", "chat"],
      }),
      (error: unknown) => error instanceof RequestError && /Duplicate WebSocket protocol/.test(error.message),
    );
  });

  test("rejects manual Sec-WebSocket-Protocol header for iterable and Headers inputs", async () => {
    await assert.rejects(
      websocket(WS_TEST_URL, {
        browser: "chrome_142",
        protocols: ["chat"],
        headers: [["Sec-WebSocket-Protocol", "chat"]],
      }),
      (error: unknown) =>
        error instanceof RequestError && /Do not set `Sec-WebSocket-Protocol` header manually/.test(error.message),
    );

    await assert.rejects(
      websocket(WS_TEST_URL, {
        browser: "chrome_142",
        protocols: ["chat"],
        headers: new WreqHeaders({ "Sec-WebSocket-Protocol": "chat" }),
      }),
      (error: unknown) =>
        error instanceof RequestError && /Do not set `Sec-WebSocket-Protocol` header manually/.test(error.message),
    );

    await assert.rejects(
      websocket(WS_TEST_URL, {
        browser: "chrome_142",
        protocols: ["chat"],
        headers: [["  Sec-WebSocket-Protocol  ", "chat"]],
      }),
      (error: unknown) =>
        error instanceof RequestError && /Do not set `Sec-WebSocket-Protocol` header manually/.test(error.message),
    );
  });

  test("helper websocket(url, options) returns an open socket and onopen is assignable after await", async () => {
    const ws = await websocket(WS_TEST_URL, { browser: "chrome_142" });

    let openEvents = 0;
    ws.onopen = () => {
      openEvents += 1;
    };

    for (let i = 0; i < 10 && openEvents === 0; i += 1) {
      await Promise.resolve();
    }

    assert.strictEqual(ws.readyState, WreqWebSocket.OPEN);
    assert.strictEqual(openEvents, 1, "onopen should fire after await websocket(...) resolves");

    ws.close();
    await waitForClose(ws);
  });

  test("websocket(url, { emulation }) connects in standalone custom mode", async () => {
    const ws = await websocket(WS_TEST_URL, {
      emulation: {
        headers: {
          "User-Agent": "Standalone WS Helper/1.0",
        },
      },
    });

    const messagePromise = waitForMessage(ws);
    await ws.send("standalone-helper");
    assert.strictEqual(dataToString((await messagePromise).data), "standalone-helper");

    ws.close();
    await waitForClose(ws);
  });

  test("message event exposes .data and supports handler assignment after construction", async () => {
    const ws = await websocket(WS_TEST_URL, { browser: "chrome_142" });

    const received: Array<string | Buffer | ArrayBuffer | Blob> = [];
    ws.onmessage = (event) => {
      received.push(event.data);
    };

    await ws.send("hello");
    await sleep(100);

    assert.ok(received.length >= 1, "should receive at least one message");
    assert.strictEqual(dataToString(received[0] as string | Buffer | ArrayBuffer | Blob), "hello");

    ws.close();
    await waitForClose(ws);
  });

  test("readyState transitions OPEN -> CLOSING -> CLOSED", async () => {
    const ws = await websocket(WS_TEST_URL, { browser: "chrome_142" });

    assert.strictEqual(ws.readyState, WreqWebSocket.OPEN);

    const closePromise = waitForClose(ws);
    ws.close();

    assert.strictEqual(ws.readyState, WreqWebSocket.CLOSING);

    await closePromise;
    assert.strictEqual(ws.readyState, WreqWebSocket.CLOSED);
  });

  test("binaryType defaults to nodebuffer and can switch to arraybuffer", async () => {
    const wsNodeBuffer = await websocket(WS_TEST_URL, { browser: "chrome_142" });
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);

    const nodeBufferMessage = waitForMessage(wsNodeBuffer);
    await wsNodeBuffer.send(bytes);
    const nodeBufferEvent = await nodeBufferMessage;

    assert.ok(Buffer.isBuffer(nodeBufferEvent.data), "default binaryType should emit Buffer");
    assert.deepStrictEqual(nodeBufferEvent.data, Buffer.from(bytes));

    wsNodeBuffer.close();
    await waitForClose(wsNodeBuffer);

    const wsArrayBuffer = await websocket(WS_TEST_URL, { browser: "chrome_142" });
    wsArrayBuffer.binaryType = "arraybuffer";

    const arrayBufferMessage = waitForMessage(wsArrayBuffer);
    await wsArrayBuffer.send(bytes);
    const arrayBufferEvent = await arrayBufferMessage;

    assert.ok(arrayBufferEvent.data instanceof ArrayBuffer, "arraybuffer binaryType should emit ArrayBuffer");
    assert.deepStrictEqual(Buffer.from(arrayBufferEvent.data), Buffer.from(bytes));

    wsArrayBuffer.close();
    await waitForClose(wsArrayBuffer);
  });

  test("binaryType supports blob payloads", async () => {
    const ws = await websocket(WS_TEST_URL, { browser: "chrome_142", binaryType: "blob" });
    const bytes = new Uint8Array([11, 12, 13]);

    const messagePromise = waitForMessage(ws);
    await ws.send(bytes);
    const event = await messagePromise;

    assert.ok(event.data instanceof Blob);
    assert.deepStrictEqual(Buffer.from(await event.data.arrayBuffer()), Buffer.from(bytes));

    ws.close();
    await waitForClose(ws);
  });

  test("addEventListener and removeEventListener work for message events", async () => {
    const ws = await websocket(WS_TEST_URL, { browser: "chrome_142" });

    let calls = 0;
    const listener = () => {
      calls += 1;
    };

    ws.addEventListener("message", listener);
    await ws.send("first");
    await sleep(100);

    ws.removeEventListener("message", listener);
    await ws.send("second");
    await sleep(100);

    assert.strictEqual(calls, 1, "listener should fire once before being removed");

    ws.close();
    await waitForClose(ws);
  });

  test("addEventListener supports listener objects, once, and signal", async () => {
    const ws = await websocket(WS_TEST_URL, { browser: "chrome_142" });
    const abortController = new AbortController();

    let objectCalls = 0;
    let onceCalls = 0;
    let abortedCalls = 0;

    const objectListener = {
      handleEvent() {
        objectCalls += 1;
      },
    };

    ws.addEventListener("message", objectListener);
    ws.addEventListener(
      "message",
      () => {
        onceCalls += 1;
      },
      { once: true },
    );
    ws.addEventListener(
      "message",
      () => {
        abortedCalls += 1;
      },
      { signal: abortController.signal },
    );

    abortController.abort();

    await ws.send("first");
    await sleep(100);
    await ws.send("second");
    await sleep(100);

    assert.strictEqual(objectCalls, 2);
    assert.strictEqual(onceCalls, 1);
    assert.strictEqual(abortedCalls, 0);

    ws.close();
    await waitForClose(ws);
  });

  test("addEventListener ignores unknown event types", async () => {
    const ws = await websocket(WS_TEST_URL, { browser: "chrome_142" });

    assert.doesNotThrow(() => {
      ws.addEventListener("custom-event", () => {
        // no-op
      });
      ws.removeEventListener("custom-event", () => {
        // no-op
      });
    });

    ws.close();
    await waitForClose(ws);
  });

  test("message listeners preserve registration order and this binding", async () => {
    const ws = await websocket(WS_TEST_URL, { browser: "chrome_142" });
    const sequence: string[] = [];

    ws.addEventListener("message", function (this: WreqWebSocket) {
      sequence.push(`l1:${String(this === ws)}`);
    });
    ws.onmessage = function () {
      sequence.push(`on:${String(this === ws)}`);
    };
    ws.addEventListener("message", function (this: WreqWebSocket) {
      sequence.push(`l2:${String(this === ws)}`);
    });

    await ws.send("ordered");
    await sleep(100);

    assert.deepStrictEqual(sequence, ["l1:true", "on:true", "l2:true"]);

    ws.close();
    await waitForClose(ws);
  });

  test("supports multiple addEventListener listeners for the same event", async () => {
    const ws = await websocket(WS_TEST_URL, { browser: "chrome_142" });

    let first = 0;
    let second = 0;

    ws.addEventListener("message", () => {
      first += 1;
    });
    ws.addEventListener("message", () => {
      second += 1;
    });

    await ws.send("fanout");
    await sleep(100);

    assert.strictEqual(first, 1);
    assert.strictEqual(second, 1);

    ws.close();
    await waitForClose(ws);
  });

  test("onclose exposes code and reason from server close frames", async () => {
    const closeUrl = new URL(WS_TEST_URL);
    closeUrl.searchParams.set("closeCode", "4001");
    closeUrl.searchParams.set("closeReason", "shutdown");

    const ws = await websocket(closeUrl, { browser: "chrome_142" });
    const closeEvent = await waitForClose(ws);

    assert.strictEqual(closeEvent.code, 4001);
    assert.strictEqual(closeEvent.reason, "shutdown");
  });

  test("url property matches constructor input", async () => {
    const url = new URL(WS_TEST_URL);
    const ws = await websocket(url, { browser: "chrome_142" });

    assert.strictEqual(ws.url, url.toString());

    ws.close();
    await waitForClose(ws);
  });

  test("constructor normalizes http websocket URLs and rejects hashes", async () => {
    const httpUrl = WS_TEST_URL.replace(/^ws:/, "http:");

    const wsFromHttp = new WreqWebSocket(httpUrl, { browser: "chrome_142" });
    await waitForOpen(wsFromHttp);
    assert.ok(wsFromHttp.url.startsWith("ws:"));
    wsFromHttp.close();
    await waitForClose(wsFromHttp);

    assert.throws(() => {
      new WreqWebSocket(`${WS_TEST_URL}#hash`, { browser: "chrome_142" });
    }, /hash fragment/i);
  });

  test("close(code, reason) sends custom close payload", async () => {
    const ws = await websocket(WS_TEST_URL, { browser: "chrome_142" });

    const closePromise = waitForClose(ws);
    ws.close(4002, "done");

    const closeEvent = await closePromise;
    assert.strictEqual(closeEvent.code, 4002);
    assert.strictEqual(closeEvent.reason, "done");
  });

  test("close validates code and reason constraints", async () => {
    const ws = await websocket(WS_TEST_URL, { browser: "chrome_142" });

    assert.throws(() => {
      ws.close(undefined, "reason");
    }, /close code/i);

    assert.throws(() => {
      ws.close(1001, "invalid-range");
    }, /1000 or in range 3000-4999/i);

    assert.throws(() => {
      ws.close(3000, "x".repeat(124));
    }, /123 bytes or fewer/i);

    ws.close(3000, "valid");
    const closeEvent = await waitForClose(ws);
    assert.strictEqual(closeEvent.code, 3000);
    assert.strictEqual(closeEvent.reason, "valid");
  });

  test("send() accepts Blob payloads", async () => {
    const ws = await websocket(WS_TEST_URL, { browser: "chrome_142" });

    const messagePromise = waitForMessage(ws);
    await ws.send(new Blob(["blob-data"], { type: "text/plain" }));
    const event = await messagePromise;

    assert.strictEqual(dataToString(event.data as string | Buffer | ArrayBuffer), "blob-data");

    ws.close();
    await waitForClose(ws);
  });

  test("session.websocket(url, options?) works with the new API shape", async () => {
    const session = await createSession({ browser: "chrome_142" });

    try {
      const ws = await session.websocket(WS_TEST_URL, {
        headers: { "X-Test": "session" },
      });

      const messagePromise = waitForMessage(ws);
      await ws.send("from-session");
      const event = await messagePromise;

      assert.strictEqual(dataToString(event.data), "from-session");

      ws.close();
      await waitForClose(ws);
    } finally {
      await session.close();
    }
  });

  test("session.websocket accepts protocols and binaryType options", async () => {
    const session = await createSession({ browser: "chrome_142" });

    try {
      const url = new URL(WS_TEST_URL);
      url.searchParams.set("requireProtocol", "chat");
      const ws = await session.websocket(url, {
        protocols: ["chat"],
        binaryType: "arraybuffer",
      });

      assert.strictEqual(ws.binaryType, "arraybuffer");
      assert.strictEqual(ws.protocol, "chat");

      const bytes = new Uint8Array([7, 8, 9]);
      const messagePromise = waitForMessage(ws);
      await ws.send(bytes);
      const event = await messagePromise;

      assert.ok(event.data instanceof ArrayBuffer);
      assert.deepStrictEqual(Buffer.from(event.data), Buffer.from(bytes));

      ws.close();
      await waitForClose(ws);
    } finally {
      await session.close();
    }
  });

  test("session.websocket sends both explicit Cookie header and session cookies", async () => {
    const session = await createSession({ browser: "chrome_142" });

    try {
      await session.fetch(httpUrl("/cookies/set?sessionCookie=jar"), { timeout: 5_000 });

      const url = new URL(WS_TEST_URL);
      url.searchParams.set("echoCookie", "1");

      const ws = await session.websocket(url, {
        headers: {
          Cookie: "manualCookie=header",
        },
      });

      const event = await waitForMessage(ws);
      const echoedCookieHeader = dataToString(event.data);

      assert.match(echoedCookieHeader, /manualCookie=header/);
      assert.match(echoedCookieHeader, /sessionCookie=jar/);

      ws.close();
      await waitForClose(ws);
    } finally {
      await session.close();
    }
  });

  test("session.websocket rejects browser/os/emulation/proxy overrides", async () => {
    const session = await createSession({ browser: "chrome_142" });

    try {
      await assert.rejects(
        session.websocket(WS_TEST_URL, { browser: "chrome_142" } as never),
        (error: unknown) =>
          error instanceof RequestError && /not supported in session\.websocket\(\)/.test(error.message),
      );

      await assert.rejects(
        session.websocket(WS_TEST_URL, { os: "windows" } as never),
        (error: unknown) =>
          error instanceof RequestError && /not supported in session\.websocket\(\)/.test(error.message),
      );

      await assert.rejects(
        session.websocket(WS_TEST_URL, { emulation: { headers: { "X-Test": "alpha" } } } as never),
        (error: unknown) =>
          error instanceof RequestError && /not supported in session\.websocket\(\)/.test(error.message),
      );

      await assert.rejects(
        session.websocket(WS_TEST_URL, { proxy: "http://proxy.example.com:8080" } as never),
        (error: unknown) =>
          error instanceof RequestError && /not supported in session\.websocket\(\)/.test(error.message),
      );
    } finally {
      await session.close();
    }
  });

  test("session.websocket rejects manual Sec-WebSocket-Protocol header when protocols is used", async () => {
    const session = await createSession({ browser: "chrome_142" });

    try {
      await assert.rejects(
        session.websocket(WS_TEST_URL, {
          protocols: ["chat"],
          headers: { "Sec-WebSocket-Protocol": "chat" },
        }),
        (error: unknown) =>
          error instanceof RequestError && /Do not set `Sec-WebSocket-Protocol` header manually/.test(error.message),
      );
    } finally {
      await session.close();
    }
  });

  test("legacy callback-in-options API still works for standalone helper", async () => {
    const messages: Array<string | Buffer> = [];
    let closeEvent: WebSocketCloseEvent | undefined;

    const ws = await websocket({
      url: WS_TEST_URL,
      browser: "chrome_142",
      onMessage: (data) => {
        messages.push(data);
      },
      onClose: (event) => {
        closeEvent = event;
      },
      onError: (error) => {
        console.error(error);
      },
    });

    await ws.send("legacy");
    await sleep(100);

    ws.close();
    await waitForClose(ws);

    assert.ok(messages.some((entry) => dataToString(entry) === "legacy"));
    assert.ok(closeEvent, "legacy onClose should receive an event");
  });

  test("legacy callback-in-options API still works for session helper", async () => {
    const session = await createSession({ browser: "chrome_142" });

    try {
      const messages: Array<string | Buffer> = [];

      const ws = await session.websocket({
        url: WS_TEST_URL,
        onMessage: (data) => {
          messages.push(data);
        },
      });

      await ws.send("legacy-session");
      await sleep(100);
      assert.ok(messages.some((entry) => dataToString(entry) === "legacy-session"));

      ws.close();
      await waitForClose(ws);
    } finally {
      await session.close();
    }
  });

  test("wraps connection errors as RequestError", { timeout: 5_000 }, async () => {
    await assert.rejects(
      websocket("ws://127.0.0.1:1", { browser: "chrome_142" }),
      (error: unknown) => error instanceof RequestError,
    );
  });

  test("rejects missing URL", async () => {
    await assert.rejects(
      websocket("", { browser: "chrome_142" }),
      (error: unknown) => error instanceof RequestError && /URL is required/.test(error.message),
    );
  });

  test("constructor emits error and close when connection fails", { timeout: 30_000 }, async () => {
    const ws = new WreqWebSocket("ws://127.0.0.1:1", { browser: "chrome_142" });
    const events: string[] = [];

    const closeEvent = await new Promise<WebSocketCloseEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Timed out waiting for close on connection failure"));
      }, 25_000);

      ws.addEventListener("error", () => {
        events.push("error");
      });
      ws.addEventListener("close", (event) => {
        events.push("close");
        clearTimeout(timer);
        resolve(event);
      });
    });

    assert.ok(events.includes("error"));
    assert.strictEqual(events.at(-1), "close");
    assert.strictEqual(closeEvent.code, 1006);
    assert.strictEqual(ws.readyState, WreqWebSocket.CLOSED);
  });

  test("send() throws before open and after close", async () => {
    const constructorWs = new WreqWebSocket(WS_TEST_URL, { browser: "chrome_142" });
    assert.throws(() => {
      constructorWs.send("too-early");
    }, /not open/i);
    constructorWs.close();
    await waitForClose(constructorWs);

    const ws = await websocket(WS_TEST_URL, { browser: "chrome_142" });
    ws.close();
    await waitForClose(ws);

    assert.throws(() => {
      ws.send("too-late");
    }, /not open/i);
  });

  test("close() before connect settles transitions to CLOSED", async () => {
    const ws = new WreqWebSocket(WS_TEST_URL, { browser: "chrome_142" });
    ws.close();
    const closeEvent = await waitForClose(ws);

    assert.ok([1000, 1005, 1006].includes(closeEvent.code));
    assert.strictEqual(ws.readyState, WreqWebSocket.CLOSED);
  });

  test("close() validates UTF 8 byte limits for multi-byte reasons", async () => {
    const ws = await websocket(WS_TEST_URL, { browser: "chrome_142" });

    assert.throws(() => {
      ws.close(3000, "😀".repeat(40));
    }, /123 bytes or fewer/i);

    ws.close(3000, "😀".repeat(30));
    const event = await waitForClose(ws);
    assert.strictEqual(event.code, 3000);
  });
});
