// The page's attention (ADR-0060 §1): looked at while visible and focused,
// told of each change; a notification under its tag, a click that brings
// the window forward; the tab's title counts, never the document's title.
import { describe, expect, test } from "vitest";
import {
  type AttentionGlobals,
  browserAttention,
} from "./browser-attention.js";

function fakes(permission: NotificationPermission = "granted") {
  const target = new EventTarget();
  const doc = new EventTarget() as EventTarget & {
    visibilityState: DocumentVisibilityState;
    focused: boolean;
    hasFocus(): boolean;
    title: string;
  };
  doc.visibilityState = "visible";
  doc.focused = true;
  doc.hasFocus = () => doc.focused;
  doc.title = "Collab Link";
  let focused = 0;
  const made: {
    title: string;
    options: object;
    closed: boolean;
    onclick: unknown;
  }[] = [];
  class FakeNotification {
    static permission = permission;
    static requestPermission = async () => "denied" as const;
    closed = false;
    onclick: (() => void) | null = null;
    constructor(title: string, options: object) {
      made.push(this as never);
      Object.assign(this, { title, options });
    }
    close() {
      this.closed = true;
    }
  }
  const globals = {
    window: Object.assign(target, { focus: () => void focused++ }),
    document: doc,
    Notification: FakeNotification,
  } as unknown as AttentionGlobals;
  return { globals, target, doc, made, focused: () => focused };
}

describe("the page's attention", () => {
  test("looked at while visible and focused, told of each change", () => {
    const f = fakes();
    const attention = browserAttention(f.globals);
    let told = 0;
    attention.subscribe(() => told++);
    expect(attention.watched()).toBe(true);
    f.doc.focused = false;
    f.target.dispatchEvent(new Event("blur"));
    expect(attention.watched()).toBe(false);
    f.doc.focused = true;
    f.doc.visibilityState = "hidden";
    f.doc.dispatchEvent(new Event("visibilitychange"));
    expect(attention.watched()).toBe(false);
    expect(told).toBe(2);
  });

  test("a notification under its tag; a click brings the window forward", () => {
    const f = fakes();
    const attention = browserAttention(f.globals);
    let clicked = 0;
    attention.notify({
      tag: "oc:d",
      title: "Report",
      body: "b",
      onClick: () => clicked++,
    });
    expect(f.made).toMatchObject([
      { title: "Report", options: { body: "b", tag: "oc:d" } },
    ]);
    (f.made[0]?.onclick as () => void)();
    expect(f.focused()).toBe(1);
    expect(clicked).toBe(1);
    expect(f.made[0]?.closed).toBe(true);
  });

  test("where a page can't make one, nothing, without an error", () => {
    const f = fakes();
    const globals = {
      ...f.globals,
      Notification: Object.assign(
        function Refusing() {
          throw new TypeError("Illegal constructor");
        },
        { permission: "granted", requestPermission: async () => "granted" },
      ),
    } as unknown as AttentionGlobals;
    const close = browserAttention(globals).notify({
      tag: "t",
      title: "x",
      body: "y",
      onClick: () => {},
    });
    expect(() => close()).not.toThrow();
  });

  test("without notifications: unsupported", async () => {
    const f = fakes();
    const { Notification: _, ...globals } = f.globals;
    const attention = browserAttention(globals);
    expect(attention.permission()).toBe("unsupported");
    expect(await attention.request()).toBe("unsupported");
  });

  test("the tab's title counts what awaits me, and comes back", () => {
    const f = fakes();
    const attention = browserAttention(f.globals);
    attention.count?.(2);
    expect(f.doc.title).toBe("(2) Collab Link");
    attention.count?.(0);
    expect(f.doc.title).toBe("Collab Link");
  });
});
