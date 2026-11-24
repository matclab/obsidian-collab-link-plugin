// @vitest-environment jsdom
// The side-by-side view's scroll sync (phase 11, decision 11) under a
// controlled order (AGENTS.md §1.6): the user's gestures (in a column,
// outside both, a key in the editor or elsewhere), the user's scrolls,
// the scrolls a column makes by itself (lines measured again: the same
// line at its top, other pixels; or the editor brought to an annotation's
// passage after a gesture outside), the animation frames, the view shown
// and hidden, the rendering aligned again, and the order of the two
// columns' scroll events: each a choice drawn by Hegel. A frame is a
// browser's: first the scroll events — one per column at most, coalesced,
// those the sync caused included —, then the animation frame callbacks,
// those requested by the events included.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterEach, describe, test } from "vitest";
import { type Pane, createScrollSync } from "./scroll-sync.js";

class ScenarioPane implements Pane {
  element = document.createElement("div");
  top = 0;
  /** A scroll event waits, until the scenario delivers it. */
  event = false;
  constructor(
    readonly name: string,
    public height: number,
    public max: number,
  ) {}
  line() {
    return this.top / this.height;
  }
  /** Where `line` puts it. */
  at(line: number) {
    return Math.min(this.max, Math.max(0, line * this.height));
  }
  show(line: number) {
    this.moveTo(this.at(line));
  }
  moveTo(top: number) {
    if (top === this.top) return; // no scroll, no event
    this.top = top;
    this.event = true;
  }
  /** Its lines measured again: the same line at its top, other pixels. */
  remeasure(height: number) {
    const line = this.line();
    this.max = (this.max * height) / this.height;
    this.height = height;
    this.moveTo(line * height);
  }
  deliver() {
    if (!this.event) return;
    this.event = false;
    this.element.dispatchEvent(new Event("scroll"));
  }
  gesture(type: string) {
    this.element.dispatchEvent(new Event(type, { bubbles: true }));
  }
}

afterEach(() => document.body.replaceChildren());

describe("scroll sync under a controlled order (property)", () => {
  test(
    "once quiet, the column the user touched last is where it went, the other level with it once it scrolled",
    () =>
      hegel.test(
        (tc) => {
          document.body.replaceChildren();
          const pane = (name: string) =>
            new ScenarioPane(
              name,
              tc.draw(gs.integers({ minValue: 1, maxValue: 40 })),
              tc.draw(gs.integers({ minValue: 0, maxValue: 4000 })),
            );
          const editor = pane("editor");
          const preview = pane("preview");
          // The page, one per case: its gestures heard there, not on a
          // document that would keep every case's listeners.
          const page = document.createElement("div");
          const outside = document.createElement("button");
          page.append(editor.element, preview.element, outside);
          document.body.append(page);
          const frames: (() => void)[] = [];
          const sync = createScrollSync(
            editor,
            preview,
            (run) => {
              frames.push(run);
            },
            page,
          );
          const panes = [editor, preview];
          let running = false;
          // Who leads: the column the user touched last, the editor
          // after a gesture outside both, or at first.
          let leader = editor;
          // The line the user (or its own measuring) put it at.
          let leaderLine = 0;
          // Whether the follower is due level with it: once it scrolled,
          // or was aligned, since it leads — a bare click moves nothing.
          let owed = false;
          const lead = (pane: ScenarioPane) => {
            if (pane !== leader) owed = false;
            leader = pane;
          };
          const frame = (previewFirst: boolean) => {
            for (const p of previewFirst ? [preview, editor] : panes) {
              p.deliver();
            }
            for (const run of frames.splice(0)) run();
          };

          const done: string[] = [];
          const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 30 }));
          for (let step = 0; step < steps; step++) {
            const action = tc.draw(
              gs.sampledFrom([
                "gesture",
                "gesture outside",
                "key",
                "scroll",
                "remeasure",
                "jump",
                "frame",
                "align",
                "stop",
                "start",
              ] as const),
            );
            const target = tc.draw(gs.sampledFrom(panes));
            done.push(`${action} ${target.name}`);
            if (action === "gesture") {
              target.gesture(
                tc.draw(gs.sampledFrom(["pointerdown", "wheel", "touchstart"])),
              );
              lead(target);
            } else if (action === "gesture outside") {
              outside.dispatchEvent(
                new Event("pointerdown", { bubbles: true }),
              );
              lead(editor);
            } else if (action === "key") {
              // Typed in the editor, or a key elsewhere (Page Down in the
              // rendering clicked last).
              if (target === editor) {
                editor.gesture("keydown");
                lead(editor);
              } else {
                page.dispatchEvent(new Event("keydown", { bubbles: true }));
              }
            } else if (action === "scroll") {
              // The user scrolls the column under their hand.
              const was = leader.top;
              leader.moveTo(
                tc.draw(
                  gs.integers({
                    minValue: 0,
                    maxValue: Math.floor(leader.max),
                  }),
                ),
              );
              if (leader.top !== was) owed = true;
            } else if (action === "remeasure") {
              target.remeasure(
                tc.draw(gs.integers({ minValue: 1, maxValue: 40 })),
              );
            } else if (action === "jump") {
              // A card chosen: its passage brought into view.
              outside.dispatchEvent(
                new Event("pointerdown", { bubbles: true }),
              );
              lead(editor);
              const was = editor.top;
              editor.moveTo(
                tc.draw(
                  gs.integers({
                    minValue: 0,
                    maxValue: Math.floor(editor.max),
                  }),
                ),
              );
              if (editor.top !== was) owed = true;
            } else if (action === "frame") frame(tc.draw(gs.booleans()));
            else if (action === "align") {
              sync.align();
              owed = true;
            } else if (action === "stop") {
              sync.stop();
              running = false;
            } else {
              // As the page does: shown, then aligned.
              sync.start();
              sync.align();
              running = true;
              owed = true;
            }
            leaderLine = leader.line();
          }

          // Quiet: every event delivered, every frame run, until nothing
          // is left — a few rounds at most, or they go back and forth.
          for (let round = 0; ; round++) {
            if (round > 4) throw new Error("the columns never settle");
            const busy = frames.length > 0 || panes.some((p) => p.event);
            if (!busy) break;
            frame(tc.draw(gs.booleans()));
          }
          if (!running) return;
          const after = done.join(", ");
          if (Math.abs(leader.line() - leaderLine) > 1e-9) {
            throw new Error(
              `${leader.name} moved from line ${leaderLine} to ${leader.line()}, after ${after}`,
            );
          }
          if (!owed) return;
          const other = leader === editor ? preview : editor;
          const want = other.at(leader.line());
          if (Math.abs(other.top - want) > 1e-9) {
            throw new Error(
              `${leader.name} leads at line ${leader.line()}, ${other.name} at ${other.top}, not ${want}, after ${after}`,
            );
          }
        },
        { testCases: 400 },
      ),
    60_000,
  );
});
