// @vitest-environment jsdom
//
// Performance budgets as work counters (docs/phase-4ter-*.md, decision 1):
// deterministic, unlike timings (those are in `npm run bench`). Every path
// that reacts to Loro changes gets one here (AGENTS.md, performances).

import type { LoroList, LoroMap } from "loro-crdt";
import { describe, expect, test } from "vitest";
import {
  listAnnotations,
  replyToAnnotation,
} from "../../lib/src/annotations/index.js";
import { eventually } from "../../lib/src/transport/test-support/eventually.js";
import type { OpenedDocument } from "../app/open-document.js";
import { obsidianLike } from "../editor/test-support/obsidian-like.js";
import { closePage, openSeeded, seedDocument, settle } from "./harness.js";
import { counter, counters, resetCounters } from "./index.js";
import { nodeScenarioSigner as scenarioSigner } from "./node-signer.js";
import { type ScenarioOptions, generateJournal } from "./scenario.js";

async function open(options: ScenarioOptions): Promise<OpenedDocument> {
  const seeded = await seedDocument(generateJournal(options));
  resetCounters();
  return openSeeded(seeded);
}

async function resolutionsToOpen(options: ScenarioOptions): Promise<number> {
  const opened = await open(options);
  closePage(opened);
  return counter("cursor.resolve");
}

describe("opening a document", () => {
  // Counters, not time: the timeout only stops a test that hangs. Half a
  // second alone, 3 to 4 s amid the whole suite — over the default 5 s on
  // a loaded machine.
  test(
    "resolves the annotations a bounded number of times, whatever the history's length",
    {
      timeout: 30_000,
    },
    async () => {
      // Five left open: their cards are drawn (ADR-0052 §1).
      const opened = await open({ annotations: 15, entries: 150, open: 5 });
      const work = counters();
      const texts = new Set(
        opened.client.index
          .current()
          // The cards shown: open ones (ADR-0052 §1).
          .annotations.filter((annotation) => annotation.status === "open")
          .flatMap((annotation) => [
            annotation.body,
            annotation.note,
            ...annotation.replies.map((reply) => reply.body),
          ])
          .filter(Boolean),
      );
      closePage(opened);

      // One import per Loro channel (was one per entry: 138), and one
      // resolution per import: the empty page, content, annotations (was 555).
      // The panel renders once more, for the confirmed decisions.
      expect(work["loro.import"]).toBe(2);
      expect(work["annotations.resolveAll"]).toBeLessThanOrEqual(3);
      expect(work["decorations.build"]).toBeLessThanOrEqual(3);
      expect(work["panel.render"]).toBeLessThanOrEqual(4);
      // The text an annotation covered: on a click or an export only
      // (ADR-0052, TA4).
      expect(work["annotations.textThen"] ?? 0).toBe(0);
      // Each annotation's text rendered once, however often its card is
      // drawn (ADR-0047 §9, MA4).
      expect(texts.size).toBeGreaterThan(0);
      expect(work["annotation.text.render"]).toBe(texts.size);
    },
  );

  test("decodes each pending suggestion's change once", async () => {
    const opened = await open({ annotations: 15, entries: 150, open: 5 });
    const work = counters();
    closePage(opened);

    // Two pending additions/substitutions among the five left open; the
    // accepted ones are already in content, which costs no decoding, and
    // a change whose dependencies haven't arrived costs none either.
    expect(work["detached.check"]).toBe(2);
  });

  // Phase 9, E4: a closed annotation (resolved, accepted, rejected) is
  // listed without its range; resolving it may cost a walk of the history
  // once its text is rewritten (analysis 9e.3).
  test("resolves the cursors of open annotations only", async () => {
    const opened = await open({ annotations: 15, entries: 150, open: 5 });
    const work = counters();
    closePage(opened);
    const resolutions = work["annotations.resolveAll"] ?? 0;
    expect(work["cursor.resolve"]).toBeLessThanOrEqual(resolutions * 5 * 2);
  });

  test("grows with the entries and with the annotations, not with their product", async () => {
    // Open annotations: closed ones are not resolved at all (E4, below).
    const base = await resolutionsToOpen({
      annotations: 2,
      open: 6,
      entries: 100,
    });
    const moreEntries = await resolutionsToOpen({
      annotations: 2,
      open: 6,
      entries: 400,
    });
    const moreAnnotations = await resolutionsToOpen({
      annotations: 2,
      open: 24,
      entries: 400,
    });

    expect(moreEntries).toBeLessThanOrEqual(base * 1.25);
    expect(moreAnnotations).toBeLessThanOrEqual(moreEntries * 4 * 1.25);
    // Counts, not time: three openings take over 5 s when the suite's
    // property tests load the machine.
  }, 20_000);
});

describe("once open", () => {
  test("a keystroke resolves no annotation and rebuilds nothing", async () => {
    const opened = await open({ annotations: 15, entries: 150, open: 5 });
    const view = opened.client.editor.view;
    resetCounters();

    view.dispatch({
      changes: { from: view.state.doc.length, insert: "k" },
      userEvent: "input.type",
    });
    await settle();
    closePage(opened);

    expect(counter("cursor.resolve")).toBe(0);
    expect(counter("annotations.resolveAll")).toBe(0);
    expect(counter("panel.render")).toBe(0);
    expect(counter("decorations.build")).toBe(0);
    expect(counter("annotation.text.render")).toBe(0);
    // Nor decodes a pending suggestion's change (ADR-0018): its widget is
    // mapped by the editor.
    expect(counter("detached.check")).toBe(0);
    // Nor renders the preview, hidden on an edit link (ADR-0021 §6).
    expect(counter("preview.render")).toBe(0);
    // Nor lists the history, hidden too — though this first keystroke
    // registers the page's peers (phase 7b).
    expect(counter("history.list")).toBe(0);
    expect(counter("history.fork")).toBe(0);
    // Presence (ADR-0025, phase 7 P5): no cursor of the others resolved, at most
    // one state sent (the 200 ms throttle itself: presence.test.ts).
    expect(counter("presence.resolve")).toBe(0);
    expect(counter("presence.publish")).toBeLessThanOrEqual(1);
  });

  // Phase 9, E3: an annotation whose text was deleted costs a walk of the
  // history to resolve; paid once, never again at each keystroke.
  test("after the text under annotations is deleted, a remote edit resolves no cursor the slow way", async () => {
    const seeded = await seedDocument(
      generateJournal({ annotations: 15, entries: 150, open: 5 }),
    );
    const reader = await openSeeded(seeded, "reader");
    const writer = await openSeeded(seeded, "writer");
    const text = reader.contentDoc.getText("content");
    const typed = async (change: {
      from: number;
      to?: number;
      insert?: string;
    }) => {
      const before = text.toString();
      writer.client.editor.view.dispatch({
        changes: change,
        userEvent: "input",
      });
      for (let i = 0; text.toString() === before && i < 1000; i++)
        await settle();
      await settle();
    };
    resetCounters();
    // All but the last character: the open annotations' text is gone, and
    // their updates point to what is left (an emptied text keeps none).
    await typed({ from: 0, to: text.length - 1 });
    expect(counter("cursor.slow")).toBeGreaterThan(0); // some anchors were there
    resetCounters();
    await typed({ from: 0, insert: "r" });
    closePage(reader);
    closePage(writer);
    expect(counter("cursor.slow")).toBe(0);
  });

  test("a remote edit resolves the annotations once and renders once", async () => {
    const seeded = await seedDocument(
      generateJournal({ annotations: 15, entries: 150, open: 5 }),
    );
    const reader = await openSeeded(seeded, "reader");
    const writer = await openSeeded(seeded, "writer");
    // Each page's state received by the other before counting: on a
    // loaded machine they came after, counted with the edit's. The writer
    // joined after the reader's went out: sent again, as at a reconnection
    // (R-P6), rather than awaiting its heartbeat.
    reader.presence.connected();
    await eventually(
      () =>
        reader.presence.others().length === 1 &&
        writer.presence.others().length === 1,
    );
    const text = reader.contentDoc.getText("content");
    const before = text.length;
    resetCounters();

    writer.client.editor.view.dispatch({
      changes: { from: 0, insert: "r" },
      userEvent: "input.type",
    });
    for (let i = 0; text.length === before && i < 1000; i++) await settle();
    await settle();
    closePage(reader);
    closePage(writer);

    // Both pages count: the writer's keystroke costs nothing (above).
    expect(counter("annotations.resolveAll")).toBeLessThanOrEqual(1);
    expect(counter("panel.render")).toBeLessThanOrEqual(1);
    expect(counter("decorations.build")).toBeLessThanOrEqual(1);
    // Pending suggestions were decoded when the page opened; since, their
    // widgets follow the text (PreviewCache).
    expect(counter("detached.check")).toBe(0);
    // The writer's cursor resolves again only when its new state arrives
    // (R-P4), not because the text changed, nor for its heartbeat (R-P7).
    expect(counter("presence.resolve")).toBeLessThanOrEqual(1);
  });

  // ADR-0035: a reply is a change of `annotations`, one recomputation of
  // the index and one rendering per reply received, like any other.
  test("a reply received resolves the annotations once and renders once", async () => {
    const seeded = await seedDocument(
      generateJournal({ annotations: 15, entries: 150, open: 5 }),
    );
    const reader = await openSeeded(seeded, "reader");
    const writer = await openSeeded(seeded, "writer");
    // An open one: its card is shown (ADR-0052 §1).
    const target = listAnnotations(
      writer.contentDoc,
      writer.annotationsDoc,
    ).find((annotation) => annotation.status === "open");
    if (!target) throw new Error("no annotation");
    // Read raw: listing would count.
    const thread = () =>
      (
        (
          reader.annotationsDoc.getMap("annotations").get(target.id) as
            | LoroMap
            | undefined
        )?.get("replies") as LoroList | undefined
      )?.length;
    const before = thread();
    resetCounters();

    replyToAnnotation(writer.annotationsDoc, target.id, {
      author: "writer",
      body: "why?",
    });
    for (let i = 0; thread() === before && i < 1000; i++) await settle();
    await settle();
    closePage(reader);
    closePage(writer);

    expect(thread()).toBe((before ?? 0) + 1);
    // Two pages, once each: the writer renders its own reply, the reader
    // the one it imports. The decorations are rebuilt too, though a reply
    // moves no range: the index tells no more than "changed".
    expect(counter("annotations.resolveAll")).toBeLessThanOrEqual(2);
    expect(counter("panel.render")).toBeLessThanOrEqual(2);
    expect(counter("decorations.build")).toBeLessThanOrEqual(2);
    expect(counter("detached.check")).toBe(0);
    // The reply's text alone, once on each page (MA4).
    expect(counter("annotation.text.render")).toBe(2);
  });
});

// Phase 18, decision 10 (docs/protocol/06-identity.md): a signature is
// verified once per object and value, never for a keystroke.
describe("a signed document", () => {
  test("opening verifies each signed object once", async () => {
    const opened = await open({
      annotations: 15,
      entries: 150,
      open: 5,
      signer: scenarioSigner(),
    });
    await opened.client.signatures.idle();
    const view = opened.client.signatures.current();
    const work = counters();
    // 20 annotations; 15 decisions, each the winner of its annotation.
    expect(work["identity.verify"]).toBe(35);
    // Their results drawn once, not once each (the 4 of an opening, and
    // one for the verifications).
    expect(work["panel.render"]).toBeLessThanOrEqual(5);
    const first = opened.client.index.current().annotations[0];
    expect(first && view.of("annotation", first.id).signed).toBe(true);
    closePage(opened);
  });

  test("a keystroke verifies nothing and draws no card", async () => {
    const opened = await open({
      annotations: 15,
      entries: 150,
      open: 5,
      signer: scenarioSigner(),
    });
    await opened.client.signatures.idle();
    const view = opened.client.editor.view;
    resetCounters();
    view.dispatch({
      changes: { from: view.state.doc.length, insert: "k" },
      userEvent: "input.type",
    });
    await settle();
    await opened.client.signatures.idle();
    closePage(opened);
    expect(counter("identity.verify")).toBe(0);
    expect(counter("cursor.resolve")).toBe(0);
    expect(counter("panel.render")).toBe(0);
    // The first keystroke registers the page's peers: the signed objects
    // read again, once.
    expect(counter("signatures.compute")).toBeLessThanOrEqual(1);
  });
});

// Phase 17: in the plugin, Write is Obsidian's editor (built here as it
// builds its own); a keystroke costs nothing there either, a remote edit
// as much as in the page.
describe("with an editor a host provides", () => {
  test("a keystroke resolves no annotation and rebuilds nothing", async () => {
    const seeded = await seedDocument(
      generateJournal({ annotations: 15, entries: 150, open: 5 }),
    );
    const opened = await openSeeded(seeded, "reader", false, obsidianLike);
    const view = opened.client.editor.view;
    resetCounters();

    view.dispatch({
      changes: { from: view.state.doc.length, insert: "k" },
      userEvent: "input.type",
    });
    await settle();
    closePage(opened);

    expect(counter("cursor.resolve")).toBe(0);
    expect(counter("annotations.resolveAll")).toBe(0);
    expect(counter("panel.render")).toBe(0);
    expect(counter("decorations.build")).toBe(0);
    expect(counter("detached.check")).toBe(0);
    expect(counter("preview.render")).toBe(0);
    expect(counter("presence.resolve")).toBe(0);
    expect(counter("presence.publish")).toBeLessThanOrEqual(1);
  });

  test("a remote edit resolves the annotations once and renders once", async () => {
    const seeded = await seedDocument(
      generateJournal({ annotations: 15, entries: 150, open: 5 }),
    );
    const reader = await openSeeded(seeded, "reader", false, obsidianLike);
    const writer = await openSeeded(seeded, "writer", false, obsidianLike);
    // Each page's state received by the other before counting: on a
    // loaded machine they came after, counted with the edit's. The writer
    // joined after the reader's went out: sent again, as at a reconnection
    // (R-P6), rather than awaiting its heartbeat.
    reader.presence.connected();
    await eventually(
      () =>
        reader.presence.others().length === 1 &&
        writer.presence.others().length === 1,
    );
    const text = reader.contentDoc.getText("content");
    const before = text.length;
    resetCounters();

    writer.client.editor.view.dispatch({
      changes: { from: 0, insert: "r" },
      userEvent: "input.type",
    });
    for (let i = 0; text.length === before && i < 1000; i++) await settle();
    await settle();
    closePage(reader);
    closePage(writer);

    expect(text.length).toBe(before + 1);
    expect(counter("annotations.resolveAll")).toBeLessThanOrEqual(1);
    expect(counter("panel.render")).toBeLessThanOrEqual(1);
    expect(counter("decorations.build")).toBeLessThanOrEqual(1);
    expect(counter("detached.check")).toBe(0);
    expect(counter("presence.resolve")).toBeLessThanOrEqual(1);
  });
});
