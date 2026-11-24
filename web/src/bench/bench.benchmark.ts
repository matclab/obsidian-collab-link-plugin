// @vitest-environment jsdom
//
// `npm run bench` (docs/phase-4ter-*.md, decision 1): wall-clock timings,
// kept out of `npm test` because they depend on the machine. Each metric is
// the median of several runs, compared with bench/reference.json: more
// than 20 % slower, or a measured size more than 20 % larger, fails.
// `npm run bench -- --update` (BENCH_UPDATE=1) records the current results
// as the new reference. Timings are jsdom's: they underestimate a real
// browser's rendering, measured with `?perf`.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { LoroMap } from "loro-crdt";
import { expect, test } from "vitest";
import {
  type DocumentConnection,
  connectDocument,
  encodeProposal,
  listAnnotations,
} from "../../lib/src/index.js";
import { EDITOR } from "../../lib/src/transport/test-support/credentials.js";
import type { OpenedDocument } from "../app/open-document.js";
import { liveBlocks } from "../editor/live-blocks.js";
import { livePreview } from "../editor/live-preview.js";
import { markdownSyntax } from "../editor/markdown-syntax.js";
import {
  type SeededDocument,
  closePage,
  openSeeded,
  seedDocument,
  settle,
} from "../perf/harness.js";
import { counters, resetCounters } from "../perf/index.js";
import { nodeScenarioSigner } from "../perf/node-signer.js";
import {
  type ScenarioOptions,
  generateJournal,
  generateLongHistory,
} from "../perf/scenario.js";
import { renderMarkdownBlocks } from "../render/index.js";
import type { Trace } from "../trace/format.js";
import { replayTrace } from "../trace/replay.js";

const benchDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../bench",
);
const RUNS = Number(process.env.BENCH_RUNS ?? 5);
const TOLERANCE = 1.2;

interface Result {
  /** Median milliseconds. */
  ms: number;
  /** Work counters of one run (deterministic). */
  counters: Record<string, number>;
  /** Size of what is measured, when it has one (deterministic). */
  bytes?: number;
  /** For comparison only, never checked: the shallow snapshot's size. */
  shallowBytes?: number;
}

/** Lets the work an action set off finish before its counters are read:
 * a frame of the history tables after a first edit, a presence state after
 * its 200 ms throttle, the other page's imports. Read as soon as the
 * action's effect shows, they counted that work or not depending on the
 * machine. Done when no counter moved for 300 ms, longer than the
 * publication (100 ms) and presence (200 ms) timers. A delay, which
 * AGENTS.md §1.6 rules out for property tests; this bench runs on real
 * time anyway, and the timing it reports is taken before. */
async function quiet(): Promise<void> {
  let last = JSON.stringify(sorted(counters()));
  let since = performance.now();
  while (performance.now() - since < 300) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await settle();
    const now = JSON.stringify(sorted(counters()));
    if (now !== last) {
      last = now;
      since = performance.now();
    }
  }
}

function sorted(record: Record<string, number>): [string, number][] {
  return Object.entries(record).sort(([x], [y]) => (x < y ? -1 : 1));
}

async function median(
  run: () => Promise<number>,
  /** Counters whose value legitimately depends on an order the bench
   * doesn't fix, with the values allowed: each says why where it's given. */
  varies: Record<string, readonly number[]> = {},
): Promise<{ ms: number; counters: Record<string, number> }> {
  if (RUNS > 1) await run(); // warm-up: WASM compilation, JIT
  const times: number[] = [];
  let measured: Record<string, number> | undefined;
  const fixed = (record: Record<string, number>) =>
    sorted(record).filter(([name]) => !(name in varies));
  for (let i = 0; i < RUNS; i++) {
    resetCounters();
    times.push(await run());
    await quiet();
    const now: Record<string, number> = { ...counters() };
    // The counters are the deterministic half of the bench (AGENTS.md
    // §6): the same work at every run, or the scenario races.
    if (measured) expect(fixed(now)).toEqual(fixed(measured));
    for (const [name, allowed] of Object.entries(varies)) {
      expect(allowed, name).toContain(now[name] ?? 0);
    }
    measured = now;
  }
  times.sort((a, b) => a - b);
  return { ms: times[Math.floor(RUNS / 2)] ?? 0, counters: measured ?? {} };
}

/** Opening, until every signature is verified:
 * the profile's 312 annotations, signed or not — open ones: the
 * scenario places them on the text as first typed, which the effects of
 * hundreds of decisions would shift. */
async function timeOpeningVerified(signed: boolean): Promise<Result> {
  const seeded = await seedDocument(
    generateJournal({
      annotations: 0,
      open: 312,
      entries: 700,
      ...(signed && { signer: nodeScenarioSigner() }),
    }),
  );
  return median(async () => {
    const start = performance.now();
    const opened = await openSeeded(seeded, "reader");
    await opened.client.signatures.idle();
    const ms = performance.now() - start;
    closePage(opened);
    return ms;
  });
}

async function timeOpening(
  options: ScenarioOptions,
  livePreview = false,
): Promise<Result> {
  const seeded = await seedDocument(generateJournal(options));
  return median(async () => {
    const start = performance.now();
    const opened = await openSeeded(seeded, "reader", livePreview);
    const ms = performance.now() - start;
    closePage(opened);
    return ms;
  });
}

/** Opening a content channel compacted after `ops` operations: one full
 * snapshot (ADR-0017), whose size grows with the history. */
async function timeLongHistory(ops: number): Promise<Result> {
  const content = generateLongHistory(ops);
  const snapshot = content.export({ mode: "snapshot" });
  const shallow = content.export({
    mode: "shallow-snapshot",
    frontiers: content.oplogFrontiers(),
  });
  const result = await median(async () => {
    const seeded = await seedDocument([
      { channel: "content", plaintext: snapshot },
    ]);
    const start = performance.now();
    const opened = await openSeeded(seeded);
    const ms = performance.now() - start;
    closePage(opened);
    return ms;
  });
  return { ...result, bytes: snapshot.length, shallowBytes: shallow.length };
}

/** A long text of callouts: `units` sections, each a
 * callout with a table and a nested callout, then a plain quote. The
 * scenario's text has no Markdown, and a cost per callout seen again for
 * each one (a lookup over all headers, a splice of all tokens) showed only
 * here. */
function calloutText(units: number): string {
  const families = ["note", "tip", "warning", "danger", "quote", "faq"];
  return Array.from({ length: units }, (_, i) =>
    [
      `## Section ${i}`,
      "",
      `Un paragraphe, du *texte* et un [lien](https://example.org) ${i}.`,
      "",
      `> [!${families[i % families.length]}]${i % 3 === 0 ? "-" : ""} Titre ${i}`,
      "> Le contenu, du `code` et du **gras**.",
      ">",
      "> | a | b |",
      "> |---|---|",
      `> | ${i} | 2 |`,
      ">",
      "> > [!bug] Imbriqué",
      "> > texte imbriqué",
      "",
      `> Une citation ordinaire ${i}.`,
      "> > imbriquée",
      "",
      "",
    ].join("\n"),
  ).join("");
}

/** The editor's formatting of that text, all of it parsed and on screen
 * (as jsdom has it). Not its opening: a long text is parsed in slices,
 * in the background, as time allows, and the work done would vary. */
async function timeFormatCallouts(units: number): Promise<Result> {
  const text = calloutText(units);
  const state = EditorState.create({
    doc: text,
    extensions: [markdownSyntax()],
  });
  const tree = ensureSyntaxTree(state, text.length, 60_000);
  if (!tree) throw new Error("the callouts' text was not parsed");
  const all = [{ from: 0, to: text.length }];
  return median(async () => {
    const start = performance.now();
    livePreview(tree, state.doc, [], all);
    liveBlocks(tree, state.doc, [], false);
    return performance.now() - start;
  });
}

/** The preview's rendering of that text (`ui/preview.ts`). */
async function timeRenderCallouts(units: number): Promise<Result> {
  const text = calloutText(units);
  return median(async () => {
    const start = performance.now();
    renderMarkdownBlocks(text);
    return performance.now() - start;
  });
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; !condition(); i++) {
    if (i > 10_000) throw new Error("the bench action never completed");
    await settle();
  }
}

/** Actions on the reference document plus five open suggestions, between
 * two connected pages. */
async function timeActions(): Promise<Record<string, Result>> {
  const options = { annotations: 15, entries: 150, open: 5 };
  const results: Record<string, Result> = {};
  let reader: OpenedDocument | undefined;
  let writer: OpenedDocument | undefined;
  let seeded: SeededDocument | undefined;
  const fresh = async (livePreview = false) => {
    if (reader) closePage(reader);
    if (writer) closePage(writer);
    seeded = await seedDocument(generateJournal(options));
    reader = await openSeeded(seeded, "reader", livePreview);
    writer = await openSeeded(seeded, "writer");
    // What the opening set off done, its presence published 200 ms ago or
    // more: a first keystroke publishes at once, then once more at the
    // end of the interval. Measured right after the opening, it waited
    // for the opening's own interval or not, depending on how long that
    // took: one publication or two (`docs/defauts-corriges.md`, 2026-10-28).
    await quiet();
    return { reader, writer, seeded };
  };

  results.keystroke = await median(async () => {
    const { reader } = await fresh();
    const view = reader.client.editor.view;
    resetCounters();
    const start = performance.now();
    for (let i = 0; i < 20; i++) {
      view.dispatch({
        changes: { from: view.state.doc.length, insert: "k" },
        userEvent: "input.type",
      });
      await settle();
    }
    return (performance.now() - start) / 20;
  });

  // The same, the text formatted as the page shows it.
  results.keystrokeFormatted = await median(async () => {
    const { reader } = await fresh(true);
    const view = reader.client.editor.view;
    resetCounters();
    const start = performance.now();
    for (let i = 0; i < 20; i++) {
      view.dispatch({
        changes: { from: view.state.doc.length, insert: "k" },
        userEvent: "input.type",
      });
      await settle();
    }
    return (performance.now() - start) / 20;
  });

  results.remoteEdit = await median(
    async () => {
      const { reader, writer } = await fresh();
      const text = reader.contentDoc.getText("content");
      const before = text.length;
      resetCounters();
      const start = performance.now();
      const view = writer.client.editor.view;
      view.dispatch({
        changes: { from: 0, insert: "remote " },
        userEvent: "input.type",
      });
      await until(() => text.length > before);
      await settle();
      return performance.now() - start;
    },
    {
      // The writer's presence and its text come by two channels, in an order
      // the real time decides: its caret, in text not yet arrived, is resolved
      // again when the text comes (R-P4), or once only (`docs/defauts-corriges.md`,
      // 2026-11-18: 1 then 2 in 3 runs out of 12).
      "presence.resolve": [1, 2],
    },
  );

  // The decision comes from a connection without a page, which applies no
  // effect, and the writer's page is closed: the reader alone applies it.
  // With two editors' pages, both raced to apply the same effect, and the
  // work counted (1, 2 or 4 frames) depended on which one won.
  results.remoteDecision = await median(async () => {
    const { reader, writer, seeded } = await fresh();
    closePage(writer);
    const proposer: DocumentConnection = await connectDocument({
      url: "fake://bench",
      documentId: seeded.documentId,
      key: seeded.key,
      credentials: EDITOR,
      channels: [],
      decisions: { onConfirmed: () => {} },
      socketFactory: () => seeded.server.connect(),
    });
    const open = listAnnotations(
      reader.contentDoc,
      reader.annotationsDoc,
    ).filter((a) => a.status === "open" && a.type === "deletion");
    // Always the same one: ids are drawn anew with each document, and the
    // list follows them; the type decides the work (a deletion edits the
    // text and the status, an addition without a change only the status).
    const [target] = open.sort(
      (x, y) => (x.range?.start ?? 0) - (y.range?.start ?? 0),
    );
    if (!target) throw new Error("no open deletion to decide");
    resetCounters();
    const start = performance.now();
    proposer.publishDecision(
      encodeProposal({
        proposalId: crypto.randomUUID(),
        annotationId: target.id,
        decision: "accept",
        author: "writer",
      }),
    );
    // Read straight from Loro: a probe must not count as work.
    const entry = reader.annotationsDoc.getMap("annotations").get(target.id);
    if (!(entry instanceof LoroMap)) throw new Error("no such annotation");
    await until(() => entry.get("status") !== "open");
    await settle();
    const ms = performance.now() - start;
    proposer.close();
    return ms;
  });

  if (reader) closePage(reader);
  if (writer) closePage(writer);
  return results;
}

/** Downloaded `?trace` files kept in bench/traces/ (or BENCH_TRACES). */
async function timeTraces(): Promise<Record<string, Result>> {
  const dir = process.env.BENCH_TRACES ?? path.join(benchDir, "traces");
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".json"));
  } catch {
    return {};
  }
  const results: Record<string, Result> = {};
  for (const file of files) {
    const trace = JSON.parse(
      readFileSync(path.join(dir, file), "utf8"),
    ) as Trace;
    results[`trace:${file}`] = await median(async () => {
      const start = performance.now();
      await replayTrace(trace);
      return performance.now() - start;
    });
  }
  return results;
}

test("bench", { timeout: 3_600_000 }, async () => {
  const results: Record<string, Result> = {};
  const record = (name: string, result: Result) => {
    results[name] = result;
    console.info(`${name}: ${result.ms.toFixed(1)} ms`);
  };
  record("openReference", await timeOpening({ annotations: 15, entries: 150 }));
  // Growth, one factor at a time (the exit criterion: linear in each).
  record(
    "openGrowthBase",
    await timeOpening({ annotations: 10, entries: 300 }),
  );
  record(
    "openGrowthEntries",
    await timeOpening({ annotations: 10, entries: 1200 }),
  );
  record(
    "openGrowthAnnotations",
    await timeOpening({ annotations: 40, entries: 300 }),
  );
  // The text formatted, as the page opens it. Typing in a
  // long document is measured in Chromium (docs/phase-11-*.md, 11e.3):
  // jsdom lays nothing out, and takes the whole text for the part on
  // screen.
  record(
    "openFormatted",
    await timeOpening({ annotations: 15, entries: 150 }, true),
  );
  // Callouts: the editor's formatting and the preview.
  record("formatCallouts", await timeFormatCallouts(400));
  // The preview's at 2000: a cost per callout for each callout added
  // 70 % there, 12 % at 400, under the bench's noise.
  record("renderCallouts", await timeRenderCallouts(2000));
  // Compaction keeps the whole history (ADR-0017): its size and opening.
  record("openUnsigned312", await timeOpeningVerified(false));
  record("openSigned312", await timeOpeningVerified(true));
  record("openLongHistory10k", await timeLongHistory(10_000));
  record("openLongHistory40k", await timeLongHistory(40_000));
  for (const [name, result] of Object.entries({
    ...(await timeActions()),
    ...(await timeTraces()),
  })) {
    record(name, result);
  }
  writeFileSync(
    path.join(benchDir, "results.json"),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  const lines = Object.entries(results).map(
    ([name, { ms, bytes, shallowBytes }]) =>
      `${name.padEnd(28)} ${ms.toFixed(1).padStart(9)} ms${
        bytes === undefined
          ? ""
          : `, ${bytes} bytes (shallow: ${shallowBytes ?? "-"})`
      }`,
  );
  console.info(lines.join("\n"));

  const referencePath = path.join(benchDir, "reference.json");
  if (process.env.BENCH_UPDATE) {
    writeFileSync(referencePath, `${JSON.stringify(results, null, 2)}\n`);
    return;
  }
  const reference = JSON.parse(readFileSync(referencePath, "utf8")) as Record<
    string,
    Result
  >;
  const regressions = Object.entries(results).flatMap(
    ([name, { ms, bytes }]) => {
      const before = reference[name];
      const slower =
        before !== undefined && ms > before.ms * TOLERANCE
          ? [
              `${name}: ${ms.toFixed(1)} ms, reference ${before.ms.toFixed(1)} ms`,
            ]
          : [];
      const larger =
        bytes !== undefined &&
        before?.bytes !== undefined &&
        bytes > before.bytes * TOLERANCE
          ? [`${name}: ${bytes} bytes, reference ${before.bytes} bytes`]
          : [];
      return [...slower, ...larger];
    },
  );
  expect(regressions).toEqual([]);
});
