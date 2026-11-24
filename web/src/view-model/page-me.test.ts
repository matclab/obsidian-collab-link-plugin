import { describe, expect, test } from "vitest";
import { PageMe } from "./page-me.js";

// Who « I » am in a page (ADR-0050 §2): a new object, and a notification,
// only when something changed.
describe("PageMe", () => {
  test("follows the pseudonym, the account and the keys", () => {
    const me = new PageMe("Alice");
    let told = 0;
    me.subscribe(() => told++);
    const first = me.current();
    expect(first).toEqual({ keys: new Set(), pseudonym: "Alice" });

    me.setPseudonym("Alice");
    me.setKeys(["b", "a"]);
    const keyed = me.current();
    expect(keyed).not.toBe(first);
    expect([...keyed.keys].sort()).toEqual(["a", "b"]);
    me.setKeys(["a", "b"]);
    expect(me.current()).toBe(keyed);

    me.setAccount({ issuer: "https://idp", sub: "u" });
    me.setAccount({ issuer: "https://idp", sub: "u" });
    expect(me.current().account).toEqual({ issuer: "https://idp", sub: "u" });
    me.setAccount(undefined);
    expect(me.current().account).toBeUndefined();
    me.setPseudonym("Alice B.");
    expect(me.current().pseudonym).toBe("Alice B.");
    expect(told).toBe(4);
  });
});
