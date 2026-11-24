import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc } from "loro-crdt";
import { afterEach, describe, expect, test, vi } from "vitest";
import { computeAnnotationsView } from "../../lib/src/annotations/index.js";
import { exportMarkdown } from "./export.js";
import { importMarkdown } from "./import.js";

// Text, markers, and markers half written or empty: what a hand-edited
// `.md` may hold.
const PIECES = [
  "a",
  "b",
  " ",
  "\n",
  "{++",
  "++}",
  "{--",
  "--}",
  "{~~",
  "~>",
  "~~}",
  "{>>",
  "<<}",
  "{++x++}",
  "{--y--}",
  "{~~z~>w~~}",
  "{>>c<<}",
  "{++x{>>c<<}++}",
  "{--y{>>c<<}--}",
  "{++++}",
  "{----}",
  "{~~~>~~}",
  "{~~q~>~~}",
  "{>><<}",
];

// Ids in creation order, the same at every run: annotations at the same
// point are written in id order, which must not change between the runs
// Hegel compares.
let nextId = 0;
function sequentialIds() {
  nextId = 0;
  vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
    nextId++;
    return `${nextId
      .toString(16)
      .padStart(16, "0")
      .replace(
        /^(.{8})(.{4})(.{4})$/,
        "$1-$2-$3",
      )}-8000-000000000000` as `${string}-${string}-${string}-${string}-${string}`;
  });
}
afterEach(() => vi.restoreAllMocks());

function imported(markdown: string) {
  const contentDoc = new LoroDoc();
  const annotationsDoc = new LoroDoc();
  let notices: ReturnType<typeof importMarkdown>;
  try {
    notices = importMarkdown(markdown, contentDoc, annotationsDoc, "carol");
  } catch (error) {
    // Refused (malformed CriticMarkup): refused before writing anything.
    const written =
      contentDoc.getText("content").length > 0 ||
      Object.keys(annotationsDoc.getMap("annotations").toJSON()).length > 0;
    if (written) throw new Error(`refused after writing: ${error}`);
    return undefined;
  }
  const text = contentDoc.getText("content").toString();
  const view = computeAnnotationsView(contentDoc, annotationsDoc);
  const exported = exportMarkdown(text, view);
  // What the annotations are, not only how they are written: a comment
  // read back as a note is written the same.
  const describe = (withRange: boolean) =>
    view.annotations
      .map((a) => {
        const preview = view.previews.get(a.id);
        return JSON.stringify([
          a.type,
          withRange ? a.range : null,
          a.body,
          a.note,
          preview?.kind === "valid" ? preview.text : undefined,
        ]);
      })
      .sort();
  const annotations = describe(true);
  // The same annotations, wherever they stand: a comment may move once,
  // before a suggestion it would otherwise follow.
  const kinds = describe(false);
  return { text, notices, exported, annotations, kinds };
}

type TC = Parameters<Parameters<typeof hegel.test>[0]>[0];

/** The property's body, and a counter-example's replay. */
function roundTrip(tc: TC): void {
  sequentialIds();
  const source = tc
    .draw(gs.arrays(gs.sampledFrom(PIECES), { maxSize: 20 }))
    .join("");
  const first = imported(source);
  if (!first) return;
  if (first.exported.kind !== "exported") {
    throw new Error(
      `import made crossing annotations: ${JSON.stringify(source)}`,
    );
  }
  if (first.exported.omitted !== 0) {
    throw new Error(
      `import made unexportable annotations: ${JSON.stringify(source)}`,
    );
  }
  // Read back, an ambiguous file may differ: it says so.
  if (first.exported.ambiguous) return;
  const again = imported(first.exported.markdown);
  if (!again || again.exported.kind !== "exported") {
    throw new Error(`our own export refused: ${first.exported.markdown}`);
  }
  // Then a fixed point: the file read back is written the same.
  const third = imported(again.exported.markdown);
  if (!third) {
    throw new Error(`our own export refused: ${again.exported.markdown}`);
  }
  const differ = (x: unknown, y: unknown) =>
    JSON.stringify(x) !== JSON.stringify(y);
  const problems = [
    again.text !== first.text &&
      `text ${JSON.stringify(again.text)} != ${JSON.stringify(first.text)}`,
    differ(again.kinds, first.kinds) &&
      `annotations ${again.kinds} != ${first.kinds}`,
    again.notices.length > 0 &&
      `notices on our own export: ${JSON.stringify(again.notices)}`,
    differ(third.exported, again.exported) &&
      `export ${JSON.stringify(third.exported)} != ${JSON.stringify(again.exported)}`,
    differ(third.annotations, again.annotations) &&
      `positions ${third.annotations} != ${again.annotations}`,
  ].filter(Boolean);
  if (problems.length > 0) {
    throw new Error(`source=${JSON.stringify(source)}\n${problems.join("\n")}`);
  }
}

/** A `tc` that gives back recorded draws, in order (Hegel prints them as
 * `draw_1`, `draw_2`… when a case fails); `done` says whether all were
 * taken. */
function replay(draws: readonly unknown[]) {
  let next = 0;
  const tc = {
    draw: () => {
      if (next >= draws.length) throw new Error("more draws than recorded");
      return draws[next++];
    },
  } as unknown as TC;
  return { tc, done: () => next === draws.length };
}

describe("CriticMarkup import and export (property)", () => {
  test(
    "a document imported then exported keeps its text and annotations, and is written the same from then on",
    () => hegel.test(roundTrip, { testCases: 500 }),
    60_000,
  );

  // Found on 2026-11-17 (phase 33e, without relation to it; red at
  // f656d95 too), the case Hegel shrank to: a comment ending with a space
  // read as « a  », written back, and read again as « a ».
  test("a counter-example kept: a comment ending with a space", () => {
    const { tc, done } = replay([["{>>", "a", " ", "<<}"]]);
    roundTrip(tc);
    expect(done()).toBe(true);
  });
});
