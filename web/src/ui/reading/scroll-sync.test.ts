// @vitest-environment jsdom
// The side-by-side view (phase 11, decision 11): the column the user
// touched last leads, the other follows at the next animation frame, once
// however many scroll events came; the follower's own scrolls move
// nothing back.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { counter, resetCounters } from "../../perf/index.js";
import { type Pane, createScrollSync } from "./scroll-sync.js";

/** A column of `height` pixels per source line, `max` pixels at most. */
class FakePane implements Pane {
  element = document.createElement("div");
  top = 0;
  constructor(
    readonly height: number,
    readonly max = Number.POSITIVE_INFINITY,
  ) {}
  line() {
    return this.top / this.height;
  }
  show(line: number) {
    this.top = Math.min(this.max, Math.max(0, line * this.height));
  }
  /** Scrolled, by the user or not: its event, as a browser sends it. */
  scroll(top: number) {
    this.top = top;
    this.element.dispatchEvent(new Event("scroll"));
  }
  /** The user's hand or wheel on it. */
  touch(type = "pointerdown") {
    this.element.dispatchEvent(new Event(type, { bubbles: true }));
  }
}

function setUp() {
  const editor = new FakePane(20);
  const preview = new FakePane(30, 600);
  const outside = document.createElement("button");
  document.body.append(editor.element, preview.element, outside);
  const frames: (() => void)[] = [];
  const sync = createScrollSync(editor, preview, (run) => {
    frames.push(run);
  });
  const frame = () => {
    for (const run of frames.splice(0)) run();
  };
  return { editor, preview, outside, sync, frames, frame };
}

beforeEach(() => resetCounters());
afterEach(() => document.body.replaceChildren());

describe("createScrollSync", () => {
  test("stopped, nothing follows", () => {
    const { editor, preview, frames } = setUp();
    editor.scroll(200);
    expect(frames).toHaveLength(0);
    expect(preview.top).toBe(0);
  });

  test("the editor leads at first: scrolled, the rendering follows at the next frame", () => {
    const { editor, preview, sync, frame } = setUp();
    sync.start();
    editor.scroll(200);
    expect(preview.top).toBe(0);
    frame();
    expect(preview.line()).toBe(10);
  });

  test("the rendering under the user's hand or wheel leads: the editor follows", () => {
    for (const gesture of ["pointerdown", "wheel", "touchstart"]) {
      const { editor, preview, sync, frame } = setUp();
      sync.start();
      preview.touch(gesture);
      preview.scroll(300);
      frame();
      expect(editor.line()).toBe(10);
      document.body.replaceChildren();
    }
  });

  test("many scroll events in a frame: one sync", () => {
    const { editor, preview, sync, frames, frame } = setUp();
    sync.start();
    for (const top of [20, 60, 100, 140]) editor.scroll(top);
    expect(frames).toHaveLength(1);
    frame();
    expect(counter("sync.scroll")).toBe(1);
    expect(preview.line()).toBe(7);
  });

  test("the follower's scrolls — the sync's own, its lines measured again — move nothing back", () => {
    const { editor, preview, sync, frames, frame } = setUp();
    sync.start();
    editor.scroll(2000); // line 100: the rendering stops at 600
    frame();
    expect(preview.top).toBe(600);
    preview.scroll(600);
    preview.scroll(580);
    expect(frames).toHaveLength(0);
    expect(editor.top).toBe(2000);
  });

  test("a gesture outside both columns (a card, a button) gives the lead back to the editor", () => {
    const { editor, preview, outside, sync, frame } = setUp();
    sync.start();
    preview.touch();
    outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    editor.scroll(100); // the card's passage brought into view
    frame();
    expect(preview.line()).toBe(5);
  });

  test("a key typed in the editor gives it the lead; a key elsewhere leaves it", () => {
    const { editor, preview, sync, frame } = setUp();
    sync.start();
    preview.touch();
    document.body.dispatchEvent(new Event("keydown", { bubbles: true }));
    preview.scroll(150); // Page Down, in the rendering clicked last
    frame();
    expect(editor.line()).toBe(5);

    editor.touch("keydown");
    editor.scroll(400);
    frame();
    expect(preview.line()).toBe(20);
  });

  test("align: the follower level with the leader, at the next frame", () => {
    const { editor, preview, sync, frame } = setUp();
    editor.top = 100;
    sync.start();
    sync.align();
    frame();
    expect(preview.line()).toBe(5);

    preview.touch();
    preview.top = 300;
    sync.align();
    frame();
    expect(editor.line()).toBe(10);
  });

  test("stopped before its frame, nothing moves", () => {
    const { editor, preview, sync, frame } = setUp();
    sync.start();
    editor.scroll(200);
    sync.stop();
    frame();
    expect(preview.top).toBe(0);
    expect(counter("sync.scroll")).toBe(0);
  });
});
