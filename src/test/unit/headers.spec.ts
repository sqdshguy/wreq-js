import assert from "node:assert";
import { describe, test } from "node:test";
import { Headers } from "../../wreq-js.js";

describe("Headers — Set-Cookie spec compliance", () => {
  test("getSetCookie returns empty array when absent", () => {
    const h = new Headers();
    assert.deepStrictEqual(h.getSetCookie(), []);
  });

  test("getSetCookie returns single value", () => {
    const h = new Headers([["set-cookie", "a=1; Path=/"]]);
    assert.deepStrictEqual(h.getSetCookie(), ["a=1; Path=/"]);
  });

  test("getSetCookie returns all values independently", () => {
    const h = new Headers();
    h.append("set-cookie", "a=1; Path=/");
    h.append("set-cookie", "b=2; HttpOnly");
    assert.deepStrictEqual(h.getSetCookie(), ["a=1; Path=/", "b=2; HttpOnly"]);
  });

  test("getSetCookie value contains comma (Expires field)", () => {
    const h = new Headers();
    h.append("set-cookie", "a=1; Expires=Fri, 01 Jan 2027 00:00:00 GMT");
    h.append("set-cookie", "b=2");
    const cookies = h.getSetCookie();
    assert.strictEqual(cookies.length, 2);
    assert.ok(cookies[0]?.includes("Expires=Fri, 01 Jan 2027"), "comma in Expires must not split the value");
  });

  test("get('set-cookie') returns comma-joined string for backward compat", () => {
    const h = new Headers();
    h.append("set-cookie", "a=1");
    h.append("set-cookie", "b=2");
    assert.strictEqual(h.get("set-cookie"), "a=1, b=2");
  });

  test("iterator yields one tuple per set-cookie value", () => {
    const h = new Headers();
    h.append("set-cookie", "a=1");
    h.append("set-cookie", "b=2");
    const tuples = [...h];
    const sc = tuples.filter(([n]) => n.toLowerCase() === "set-cookie");
    assert.strictEqual(sc.length, 2);
    assert.strictEqual(sc[0]?.[1], "a=1");
    assert.strictEqual(sc[1]?.[1], "b=2");
  });

  test("toTuples emits separate tuples for each set-cookie value", () => {
    const h = new Headers();
    h.append("set-cookie", "a=1");
    h.append("set-cookie", "b=2");
    const tuples = h.toTuples();
    const sc = tuples.filter(([n]) => n.toLowerCase() === "set-cookie");
    assert.strictEqual(sc.length, 2);
  });

  test("toObject uses comma-join for set-cookie (lossy, consistent with get)", () => {
    const h = new Headers();
    h.append("set-cookie", "a=1");
    h.append("set-cookie", "b=2");
    const obj = h.toObject();
    const val = obj["set-cookie"] ?? obj["Set-Cookie"];
    assert.strictEqual(val, "a=1, b=2");
  });

  test("round-trip via new Headers(existingHeaders) preserves set-cookie values", () => {
    const src = new Headers();
    src.append("set-cookie", "a=1");
    src.append("set-cookie", "b=2");
    const clone = new Headers(src);
    assert.deepStrictEqual(clone.getSetCookie(), ["a=1", "b=2"]);
  });

  test("non-set-cookie multi-value still comma-joins (existing behaviour)", () => {
    const h = new Headers({ "X-Test": "alpha" });
    h.append("x-test", "beta");
    assert.strictEqual(h.get("X-Test"), "alpha, beta");
  });

  test("keys() emits set-cookie once per value", () => {
    const h = new Headers();
    h.append("set-cookie", "a=1");
    h.append("set-cookie", "b=2");
    const keys = [...h.keys()];
    assert.strictEqual(keys.filter((k) => k.toLowerCase() === "set-cookie").length, 2);
  });

  test("forEach calls callback once per set-cookie value", () => {
    const h = new Headers();
    h.append("set-cookie", "a=1");
    h.append("set-cookie", "b=2");
    const seen: string[] = [];
    h.forEach((v, n) => {
      if (n.toLowerCase() === "set-cookie") seen.push(v);
    });
    assert.deepStrictEqual(seen, ["a=1", "b=2"]);
  });
});
