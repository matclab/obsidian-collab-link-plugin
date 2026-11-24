// @vitest-environment jsdom
//
// Who wrote, in the preview (ADR-0059 §6; analysis 33, AV8; AGENTS.md
// §1.6): every source of asynchrony is a choice of the test — the page's
// typing, another's changes arriving, a name registered, the switch, the
// preview shown or hidden, its regrouping timer, and each pending reading
// or notification of the authorship, in any order. At every step, nothing
// is read nor drawn while off (AU3), and switching keeps every block the
// preview drew (AU5); once nothing is pending, each block's bar is its
// persons' shares, read from Loro itself (AU2 for the bars).

import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { registerPeers } from "../../../lib/src/history/tables.js";
import { createDocumentEditor } from "../../editor/editor.js";
import {
  authorRuns,
  authors,
  personOf,
  personOrder,
} from "../../history/authorship.js";
import { counter, resetCounters } from "../../perf/index.js";
import { RENDER_DELAY_MS, createPreview } from "../reading/preview.js";
import type { Mode } from "../reading/view-switch.js";
import { attachAuthorshipView } from "./authorship-view.js";

type TC = Parameters<Parameters<typeof hegel.testAsync>[0]>[0];

// Not faked: the preview's own work outside the held steps runs in
// microtasks, all done by the next macrotask.
const tick = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

const sync = (from: LoroDoc, to: LoroDoc) =>
  to.import(from.export({ mode: "update", from: to.oplogVersion() }));

/** What a block's bar should be, from Loro itself. */
function expectedBar(
  page: LoroDoc,
  names: ReadonlyMap<string, string>,
  from: number,
  to: number,
): string {
  const order = personOrder(page, names);
  const shares = new Map<number, number>();
  for (const run of authorRuns(page.getText("content"), from, to)) {
    const place = order.indexOf(personOf(run.peer, names).key);
    const rank = place < 0 ? Number.POSITIVE_INFINITY : (place % 8) + 1;
    shares.set(rank, (shares.get(rank) ?? 0) + run.to - run.from);
  }
  const total = [...shares.values()].reduce((sum, n) => sum + n, 0);
  let at = 0;
  const stops = [...shares]
    .sort(([x], [y]) => x - y)
    .map(([rank, length]) => {
      const start = at;
      at += (100 * length) / total;
      const name = rank === Number.POSITIVE_INFINITY ? "unknown" : rank;
      return `var(--author-${name}-line) ${start.toFixed(2)}% ${at.toFixed(2)}%`;
    });
  return stops.length > 0 ? `linear-gradient(${stops.join(", ")})` : "";
}

async function scenario(tc: TC): Promise<void> {
  const page = new LoroDoc();
  page.setPeerId(1n);
  const other = new LoroDoc();
  other.setPeerId(2n);
  // Longer than what the editor shows (jsdom: 674 characters): the bars
  // need the whole text read.
  other
    .getText("content")
    .insert(
      0,
      `alpha beta\n\ngamma\n\n- one\n- two\n${"\nA paragraph long enough to fill lines.\n".repeat(30)}`,
    );
  other.commit();
  sync(other, page);
  const annotationsDoc = new LoroDoc();
  const parent = document.createElement("div");
  const bar = document.createElement("div");
  parent.append(bar);
  document.body.append(parent);
  const editor = createDocumentEditor(parent, page);
  const preview = createPreview(parent, editor.view, {});
  let mode: Mode = "write";
  const modeListeners: ((mode: Mode) => void)[] = [];
  const queue: (() => void)[] = [];
  const shown = attachAuthorshipView({
    editor,
    contentDoc: page,
    annotationsDoc,
    parent,
    views: {
      bar,
      mode: () => mode,
      onMode: (listener) => modeListeners.push(listener),
      preview,
    },
    schedule: (run) => queue.push(run),
  });
  const on = () => shown.authorship.on();
  const blocks = () =>
    (Array.from(preview.root.children) as HTMLElement[]).filter(
      (block) => block.dataset.line !== undefined,
    );

  const calm = () => {
    if (!on() || !preview.visible || queue.length > 0) return;
    if (vi.getTimerCount() > 0) return;
    const names = authors(annotationsDoc);
    const { doc } = editor.view.state;
    for (const block of blocks()) {
      const first = Number(block.dataset.line);
      const end = Math.min(Number(block.dataset.lineEnd), doc.lines);
      if (first >= doc.lines || end <= first) continue;
      const expected = expectedBar(
        page,
        names,
        doc.line(first + 1).from,
        doc.line(end).to,
      );
      expect(block.dataset.authors ?? "").toBe(expected);
    }
  };

  const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 25 }));
  for (let step = 0; step < steps; step++) {
    const wasOn = on();
    resetCounters();
    const move = tc.draw(
      gs.sampledFrom([
        "type",
        "remote",
        "name",
        "switch",
        "preview",
        "timer",
        // One gesture: typing, then its rendering.
        "typeThenRender",
        "run",
        "run",
        // One gesture: everything pending, in order.
        "drain",
        // One gesture: the timer, then everything pending, until calm.
        "settle",
        "settle",
      ] as const),
    );
    let before: HTMLElement[] | undefined;
    if (move === "type" || move === "typeThenRender") {
      const at = tc.draw(
        gs.integers({ minValue: 0, maxValue: editor.view.state.doc.length }),
      );
      const insert = tc.draw(gs.sampledFrom(["a", "b c", "\n\nnew"]));
      editor.view.dispatch({ changes: { from: at, insert } });
      if (move === "typeThenRender") vi.advanceTimersByTime(RENDER_DELAY_MS);
    } else if (move === "remote") {
      sync(page, other);
      const text = other.getText("content");
      const at = tc.draw(gs.integers({ minValue: 0, maxValue: text.length }));
      text.insert(at, tc.draw(gs.sampledFrom(["x", "\n\nzz", "yy"])));
      other.commit();
      sync(other, page);
    } else if (move === "name") {
      registerPeers(
        annotationsDoc,
        [tc.draw(gs.sampledFrom(["1", "2"]))],
        tc.draw(gs.sampledFrom(["alice", "bob"])),
      );
    } else if (move === "switch") {
      before = blocks();
      shown.toggle.click();
    } else if (move === "preview") {
      if (preview.visible) preview.hide();
      else preview.show();
      editor.view.dom.hidden = preview.visible;
      for (const listener of modeListeners) listener(mode);
    } else if (move === "timer") {
      vi.advanceTimersByTime(RENDER_DELAY_MS);
    } else if (move === "drain") {
      while (queue.length > 0) queue.shift()?.();
    } else if (move === "settle") {
      for (let round = 0; round < 3; round++) {
        vi.advanceTimersByTime(RENDER_DELAY_MS);
        await tick();
        while (queue.length > 0) queue.shift()?.();
      }
    } else if (queue.length > 0) {
      const i = tc.draw(
        gs.integers({ minValue: 0, maxValue: queue.length - 1 }),
      );
      queue.splice(i, 1)[0]?.();
    }
    await tick();
    // AU3: a step that stayed off read and drew nothing.
    if (!wasOn && !on()) {
      expect(counter("authorship.char")).toBe(0);
      expect(counter("authorship.bars")).toBe(0);
      expect(preview.root.classList.contains("authorship-on")).toBe(false);
    }
    // AU5: switching keeps every block the preview drew.
    if (before) expect(blocks()).toEqual(before);
    calm();
  }
  // Everything pending done: calm.
  vi.advanceTimersByTime(RENDER_DELAY_MS);
  await tick();
  while (queue.length > 0) queue.shift()?.();
  await tick();
  calm();
  mode = "write";
  shown.destroy();
  editor.destroy();
}

describe("who wrote in the preview, every order (analysis 33, AV8)", () => {
  test(
    "each block's bar its persons' shares once calm; nothing off; blocks kept",
    () => hegel.testAsync(scenario, { testCases: 300 }),
    180_000,
  );
});
