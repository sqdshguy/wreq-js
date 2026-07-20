import assert from "node:assert";
import { describe, test } from "node:test";
import { Session, Transport, WebSocket } from "../../wreq-js.js";

describe("explicit resource management", () => {
  test("await using closes a Transport", async () => {
    const transport = new Transport("test-transport");
    let closeCalls = 0;
    transport.close = async () => {
      closeCalls += 1;
    };

    {
      await using resource = transport;
      assert.strictEqual(resource, transport);
      assert.strictEqual(closeCalls, 0);
    }

    assert.strictEqual(closeCalls, 1);
  });

  test("await using closes a Session", async () => {
    const session = Object.create(Session.prototype) as Session;
    let closeCalls = 0;
    session.close = async () => {
      closeCalls += 1;
    };

    {
      await using resource = session;
      assert.strictEqual(resource, session);
      assert.strictEqual(closeCalls, 0);
    }

    assert.strictEqual(closeCalls, 1);
  });

  test("using closes a WebSocket", () => {
    const socket = Object.create(WebSocket.prototype) as WebSocket;
    let closeCalls = 0;
    socket.close = () => {
      closeCalls += 1;
    };

    {
      using resource = socket;
      assert.strictEqual(resource, socket);
      assert.strictEqual(closeCalls, 0);
    }

    assert.strictEqual(closeCalls, 1);
  });
});
