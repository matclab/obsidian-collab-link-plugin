// A view's attention in Obsidian (ADR-0060 §1; phase 34d): looked at while
// the window has the focus and the leaf is active; a click brings both
// forward; no count of the window's title; its listeners gone once
// nobody listens.
import { describe, expect, test } from "vitest";
import { type LeafAttentionHost, leafAttention } from "./leaf-attention.js";

function fakes() {
  const target = new EventTarget();
  let listening = 0;
  const window = {
    addEventListener: (type: string, listener: () => void) => {
      listening++;
      target.addEventListener(type, listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      listening--;
      target.removeEventListener(type, listener);
    },
    focus: () => void focused++,
  };
  let focused = 0;
  let hasFocus = true;
  let active = true;
  let revealed = 0;
  const activeListeners = new Set<() => void>();
  const made: { onclick: (() => void) | null; closed: boolean }[] = [];
  class FakeNotification {
    static permission = "granted" as const;
    static requestPermission = async () => "granted" as const;
    onclick: (() => void) | null = null;
    closed = false;
    constructor() {
      made.push(this);
    }
    close() {
      this.closed = true;
    }
  }
  const host = {
    window,
    document: { hasFocus: () => hasFocus },
    Notification: FakeNotification,
    active: () => active,
    onActiveChange: (listener: () => void) => {
      activeListeners.add(listener);
      return () => activeListeners.delete(listener);
    },
    reveal: () => void revealed++,
  } as unknown as LeafAttentionHost;
  return {
    host,
    made,
    target,
    setFocus: (v: boolean) => {
      hasFocus = v;
    },
    setActive: (v: boolean) => {
      active = v;
      for (const listener of activeListeners) listener();
    },
    counts: () => ({
      focused,
      revealed,
      listening,
      active: activeListeners.size,
    }),
  };
}

describe("a view's attention in Obsidian", () => {
  test("looked at only focused and active, told of each change", () => {
    const f = fakes();
    const attention = leafAttention(f.host);
    let told = 0;
    const stop = attention.subscribe(() => told++);
    expect(attention.watched()).toBe(true);
    f.setActive(false);
    expect(attention.watched()).toBe(false);
    f.setActive(true);
    f.setFocus(false);
    f.target.dispatchEvent(new Event("blur"));
    expect(attention.watched()).toBe(false);
    expect(told).toBe(3);
    stop();
    expect(f.counts()).toMatchObject({ listening: 0, active: 0 });
  });

  test("a click brings the window and the leaf forward", () => {
    const f = fakes();
    let clicked = 0;
    leafAttention(f.host).notify({
      tag: "t",
      title: "x",
      body: "y",
      onClick: () => clicked++,
    });
    f.made[0]?.onclick?.();
    expect(f.counts()).toMatchObject({ focused: 1, revealed: 1 });
    expect(clicked).toBe(1);
    expect(f.made[0]?.closed).toBe(true);
  });

  test("no count of the window's title", () => {
    expect(leafAttention(fakes().host).count).toBeUndefined();
  });
});
