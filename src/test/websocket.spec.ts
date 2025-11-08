import assert from "node:assert";
import { before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { websocket } from "../wreq-js";

describe("WebSocket", () => {
  before(() => {
    console.log("🔌 WebSocket Test Suite\n");
  });

  test("should connect to WebSocket and send/receive messages", async () => {
    const messages: (string | Buffer)[] = [];
    let isClosed = false;

    const ws = await websocket({
      url: "wss://echo.websocket.org",
      browser: "chrome_137",
      onMessage: (data) => {
        messages.push(data);
      },
      onClose: () => {
        isClosed = true;
      },
      onError: (error) => {
        console.error("WebSocket error:", error);
      },
    });

    console.log("WebSocket connected");

    await ws.send("Hello!");

    // Wait for echo response
    await sleep(1000);
    assert.ok(messages.length > 0, "Should receive at least one message");

    // Wait a bit for close callback
    await ws.close();
    await sleep(10000);
    assert.ok(isClosed, "Should receive close event");

    // Rate limit protection: wait before next test
    await sleep(2000);
  });

  test("should handle parallel sends on same WebSocket", async () => {
    const messages: (string | Buffer)[] = [];
    const expectedMessages = ["Message 1", "Message 2", "Message 3", "Message 4", "Message 5"];

    const ws = await websocket({
      url: "wss://echo.websocket.org",
      browser: "chrome_137",
      onMessage: (data) => {
        messages.push(data);
      },
      onClose: () => {},
      onError: (error) => {
        console.error("WebSocket error:", error);
      },
    });

    console.log("Testing parallel sends...");

    // Send multiple messages in parallel
    await Promise.all([
      ws.send("Message 1"),
      ws.send("Message 2"),
      ws.send("Message 3"),
      ws.send("Message 4"),
      ws.send("Message 5"),
    ]);

    console.log("All messages sent in parallel");

    // Wait for echo responses
    await sleep(2000);

    assert.ok(messages.length >= 5, "Should receive at least 5 messages");

    // Verify that all expected messages were received (order may vary)
    const receivedStrings = messages.map((m) => (Buffer.isBuffer(m) ? m.toString() : m));

    for (const expected of expectedMessages) {
      assert.ok(
        receivedStrings.includes(expected),
        `Should receive message: "${expected}". Got: ${receivedStrings.join(", ")}`,
      );
    }
    console.log("All messages received correctly:", receivedStrings.join(", "));

    await ws.close();

    // Rate limit protection: wait before next test
    await sleep(2000);
  });

  test("should handle multiple WebSocket connections simultaneously", async () => {
    const ws1Messages: (string | Buffer)[] = [];
    const ws2Messages: (string | Buffer)[] = [];

    // Create two WebSocket connections in parallel
    const [ws1, ws2] = await Promise.all([
      websocket({
        url: "wss://echo.websocket.org",
        browser: "chrome_137",
        onMessage: (data) => ws1Messages.push(data),
        onClose: () => {},
        onError: () => {},
      }),
      websocket({
        url: "wss://echo.websocket.org",
        browser: "firefox_139",
        onMessage: (data) => ws2Messages.push(data),
        onClose: () => {},
        onError: () => {},
      }),
    ]);

    console.log("WebSocket connections created");

    // Send unique messages on both connections in parallel
    await Promise.all([ws1.send("From WS1"), ws2.send("From WS2")]);

    // Wait for responses (long timeout for CI)
    await sleep(5000);

    assert.ok(ws1Messages.length > 0, "WS1 should receive messages");
    assert.ok(ws2Messages.length > 0, "WS2 should receive messages");

    // Verify that each connection received the correct message (not mixed up)
    // Note: echo.websocket.org sends a "Request served by..." message first, then echoes
    const ws1Strings = ws1Messages.map((m) => (Buffer.isBuffer(m) ? m.toString() : m));
    const ws2Strings = ws2Messages.map((m) => (Buffer.isBuffer(m) ? m.toString() : m));

    assert.ok(ws1Strings.includes("From WS1"), "WS1 should receive its own message");
    assert.ok(ws2Strings.includes("From WS2"), "WS2 should receive its own message");

    // Verify messages are not mixed up between connections
    assert.ok(!ws1Strings.includes("From WS2"), "WS1 should NOT receive WS2 message");
    assert.ok(!ws2Strings.includes("From WS1"), "WS2 should NOT receive WS1 message");

    console.log("Messages correctly isolated between connections:");
    console.log("  WS1:", ws1Strings);
    console.log("  WS2:", ws2Strings);

    // Close both connections
    await Promise.all([ws1.close(), ws2.close()]);
  });
});
