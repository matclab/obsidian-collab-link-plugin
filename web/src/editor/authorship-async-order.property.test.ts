// @vitest-environment jsdom
//
// Who wrote, in the editor (ADR-0059 §5; analysis 33, AGENTS.md §1.6):
// every source of asynchrony is a choice of the test — the page's typing,
// another page's changes arriving through the link to Loro, a name
// registered, the switch, and each pending reading or notification run in
// any order (the authorship's and the names'). At every step, a character
// marked is marked by its author (AU1), and nothing is marked or read while
// off (AU3); once nothing is pending, every shown character is marked, by
// its person's color (AU2, AU4). Stopped, nothing more is read (AU6).
//
// jsdom lays nothing out: the shown ranges are the whole text, and
// scrolling isn't drawn here (checked in a real browser, phase 33d).

import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { registerPeers } from "../../lib/src/history/tables.js";
import { AuthorNames } from "../history/author-names.js";
import { personOf, personOrder } from "../history/authorship.js";
import { counter, resetCounters } from "../perf/index.js";
import { attachAuthorship, authorMarks } from "./authorship.js";
import { createDocumentEditor } from "./editor.js";

type TC = Parameters<Parameters<typeof hegel.test>[0]>[0];

const sync = (from: LoroDoc, to: LoroDoc) =>
  to.import(from.export({ mode: "update", from: to.oplogVersion() }));

/** The positions between two characters, never inside a pair. */
function boundaries(text: string): number[] {
  const at = [0];
  for (const char of text) at.push((at.at(-1) as number) + char.length);
  return at;
}

const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

function scenario(tc: TC): void {
  const page = new LoroDoc();
  page.setPeerId(1n);
  const others = [2n, 3n].map((peer) => {
    const doc = new LoroDoc();
    doc.setPeerId(peer);
    return doc;
  });
  const first = others[0] as LoroDoc;
  first.getText("content").insert(0, "hello 😀 world");
  first.commit();
  sync(first, page);
  const annotationsDoc = new LoroDoc();
  const queue: (() => void)[] = [];
  const schedule = (run: () => void) => queue.push(run);
  const editor = createDocumentEditor(document.createElement("div"), page);
  const { view } = editor;
  const names = new AuthorNames(annotationsDoc, schedule);
  const authorship = attachAuthorship(view, page, names, { schedule });
  const text = page.getText("content");

  const check = (offDuringStep: boolean) => {
    const marks = authorMarks(view.state);
    if (!authorship.on()) expect(marks).toEqual([]);
    // AU3: nothing read in a step that stayed off.
    if (offDuringStep) expect(counter("authorship.char")).toBe(0);
    // AU1: a mark tells the author of each of its characters.
    let end = 0;
    for (const { from, to, peer } of marks) {
      expect(from).toBeGreaterThanOrEqual(end);
      end = to;
      for (let at = from; at < to; at++) {
        if (isLowSurrogate(view.state.doc.toString().charCodeAt(at))) continue;
        expect(text.getEditorOf(at)).toBe(peer);
      }
    }
  };
  const calm = () => {
    if (!authorship.on() || queue.length > 0) return;
    // AU2, AU4: every shown character marked, by its person's color.
    const known = names.current();
    const order = personOrder(page, known);
    const covered: number[] = [];
    for (const { from, to, peer, className } of authorMarks(view.state)) {
      const place = order.indexOf(personOf(peer, known).key);
      expect(className).toBe(
        `cm-author ${place < 0 ? "cm-author-unknown" : `cm-author-${(place % 8) + 1}`}`,
      );
      for (let at = from; at < to; at++) covered.push(at);
    }
    const shown: number[] = [];
    for (const { from, to } of view.visibleRanges) {
      for (let at = from; at < to; at++) shown.push(at);
    }
    expect(covered.filter((at) => shown.includes(at))).toEqual(shown);
  };

  const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 30 }));
  for (let step = 0; step < steps; step++) {
    const wasOn = authorship.on();
    resetCounters();
    const move = tc.draw(
      gs.sampledFrom([
        "type",
        "delete",
        "remote",
        "name",
        "switch",
        "run",
        "run",
      ] as const),
    );
    if (move === "type" || move === "delete") {
      const at = boundaries(view.state.doc.toString());
      if (move === "delete" && at.length > 1) {
        const i = tc.draw(
          gs.integers({ minValue: 0, maxValue: at.length - 2 }),
        );
        const j = tc.draw(
          gs.integers({ minValue: i + 1, maxValue: at.length - 1 }),
        );
        view.dispatch({
          changes: { from: at[i] as number, to: at[j] as number },
          userEvent: "delete",
        });
      } else {
        const where = tc.draw(gs.sampledFrom(at));
        const insert = tc.draw(gs.sampledFrom(["a", "bc", "🎉"]));
        view.dispatch({
          changes: { from: where, insert },
          userEvent: "input.type",
        });
      }
    } else if (move === "remote") {
      // Another page catches up, edits, then its changes arrive here:
      // one import of one or more of its changes.
      const other = tc.draw(gs.sampledFrom(others));
      sync(page, other);
      const edits = tc.draw(gs.integers({ minValue: 1, maxValue: 3 }));
      for (let e = 0; e < edits; e++) {
        const otherText = other.getText("content");
        const at = boundaries(otherText.toString());
        if (at.length > 1 && tc.draw(gs.booleans())) {
          const i = tc.draw(
            gs.integers({ minValue: 0, maxValue: at.length - 2 }),
          );
          otherText.delete(
            at[i] as number,
            (at[i + 1] as number) - (at[i] as number),
          );
        } else {
          otherText.insert(
            tc.draw(gs.sampledFrom(at)),
            tc.draw(gs.sampledFrom(["x", "yz", "🌍"])),
          );
        }
        other.commit();
      }
      sync(other, page);
    } else if (move === "name") {
      const peer = tc.draw(gs.sampledFrom(["1", "2", "3"]));
      registerPeers(
        annotationsDoc,
        [peer],
        tc.draw(gs.sampledFrom(["alice", "bob", "carol"])),
      );
    } else if (move === "switch") {
      authorship.setOn(!authorship.on());
    } else if (queue.length > 0) {
      const i = tc.draw(
        gs.integers({ minValue: 0, maxValue: queue.length - 1 }),
      );
      const [run] = queue.splice(i, 1);
      run?.();
    }
    check(!wasOn && !authorship.on());
    calm();
  }
  // Everything pending done: calm.
  while (queue.length > 0) queue.shift()?.();
  check(false);
  calm();
  // AU6: stopped, what is still pending reads nothing.
  if (authorship.on()) view.dispatch({ changes: { from: 0, insert: "q" } });
  authorship.destroy();
  resetCounters();
  while (queue.length > 0) queue.shift()?.();
  expect(counter("authorship.char")).toBe(0);
  editor.destroy();
}

describe("who wrote in the editor, every order (analysis 33)", () => {
  test(
    "a mark tells its characters' author; all shown once calm; nothing read off or stopped",
    () => hegel.test(scenario, { testCases: 400 }),
    120_000,
  );
});
