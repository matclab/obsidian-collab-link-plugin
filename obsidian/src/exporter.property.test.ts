// The linked note's export (docs/phase-14-plugin-obsidian.md, decisions 3
// and 4; analyses 14c and 14e): every source of asynchrony is the test's
// choice, drawn by Hegel — typing, another device's typing and its import,
// the export's timer (fake timers), the end of each `vault.process` and of
// each copy, a change from outside (text, header reformatted or gone, a
// version not received yet), another device's export brought by a sync,
// Obsidian's `modify`, resuming a change (once or twice), a rename, a
// deletion, "Unlink", closing the view; and, too precise for chance, a
// change from outside noticed, found by a write and kept in one gesture
// (`outsideKept`), without which no resume was ever drawn. Checked at each
// write: ME1 (nothing written over but the last export, an export of a
// version held, or a file already kept in a copy), NE2 (the text is the
// one of the version written), NE3 (versions only grow), NE5 (nothing
// written after unlinking); at each copy, ME2, and never of an export
// (OI2); at each resume, ME3 (a change from its base; the file's text
// without concurrency) and ME4 (twice, a peer drawn each time, enters
// once); at rest, NE1 (the file is the export of the last version); after
// a close, the file holds what the view held.
//
// And the document's attached images (ADR-0058, analysis 32): each image
// the writer asks for opens or fails when the test says; a file deleted
// by hand, or brought by a sync; another device's export citing files;
// the setting switched. VI1: an export cites exactly the files there when
// it is written; VI2: a file never replaced; VI4: none created after
// unlinking or closing; VI5: what is resumed cites no file; VI3: compared
// to the document brought back (OI2 below).
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ImageFormat } from "../../web/lib/src/index.js";
import { NoteExporter, type Outside } from "./exporter.js";
import { ImageWriter } from "./image-writer.js";
import {
  formatVersion,
  parseVersion,
  readHeader,
  readLooseHeader,
  writeHeader,
} from "./note-header.js";
import { resumeChange, resumePeer } from "./resume.js";
import { notedImages, toDocument, toNote } from "./vault-images.js";

const DOCUMENT = "doc";
const DELAY = 1000;
const FOLDER = "Collab Link";
const IMAGES = ["AAAAAAAAAAAAAAAAAAAAAA", "AQAAAAAAAAAAAAAAAAAAAg"];

interface Pending {
  fn: (current: string) => string;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
}

/** The vault, as the exporter sees it: one file, whose `process` ends when
 * the test says — reading and writing in one operation, as Obsidian's. */
class FakeVault {
  readonly file = { path: "Collab Link/Note.md" };
  deleted = false;
  pending: Pending[] = [];
  constructor(public text: string) {}

  process(_file: object, fn: (current: string) => string): Promise<string> {
    return new Promise((resolve, reject) =>
      this.pending.push({ fn, resolve, reject }),
    );
  }
}

const textOf = (doc: LoroDoc) => doc.getText("content").toString();

/** Whether `doc` holds every operation of `version`. */
function holds(doc: LoroDoc, version: string): boolean {
  const vv = doc.oplogVersion();
  return (parseVersion(version) ?? [{ peer: "0", counter: 2 ** 31 }]).every(
    ({ peer, counter }) => (vv.get(peer) ?? 0) > counter,
  );
}

/** The text of `doc` at the version a file names, or `undefined`. */
function textAt(doc: LoroDoc, version: string): string | undefined {
  const frontiers = parseVersion(version);
  if (!frontiers) return undefined;
  try {
    return textOf(doc.forkAt(frontiers));
  } catch {
    return undefined;
  }
}

/** An edit of `doc` at a drawn place. */
function edit(tc: hegel.TestCase, doc: LoroDoc): void {
  const text = doc.getText("content");
  const at = tc.draw(gs.integers({ minValue: 0, maxValue: text.length }));
  if (text.length > 0 && tc.draw(gs.booleans())) {
    text.delete(Math.min(at, text.length - 1), 1);
  } else {
    text.insert(
      at,
      tc.draw(
        gs.sampledFrom([
          "a",
          "b",
          "\n",
          "é",
          ...IMAGES.map((id) => ` ![i](attachment:${id}) `),
        ]),
      ),
    );
  }
  doc.commit();
}

type Start = "new" | "current" | "older" | "unknown" | "edited";
type Move =
  | "type"
  | "otherTypes"
  | "remote"
  | "timer"
  | "complete"
  | "kept"
  | "outside"
  | "outsideKept"
  | "renameRewrite"
  | "sync"
  | "syncAhead"
  | "modify"
  | "resume"
  | "resumeTwice"
  | "rename"
  | "delete"
  | "unlink"
  | "unlinkWhileWriting"
  | "close"
  | "imageOpens"
  | "imageFails"
  | "fileDeleted"
  | "fileSynced"
  | "syncFiles"
  | "toggle"
  | "filesSyncedFound"
  | "outsideOnFiles"
  | "stopWhileOpening";
type Change =
  | "text"
  | "reformat"
  | "noHeader"
  | "unknownVersion"
  /** A rename's rewrite of the file as it is (phase 19, decision 10): a
   * link renamed, here a `[[D]]` the stand-in recognizes. */
  | "linkRenamed";

/** What a rename's rewrite adds, for the stand-in of `isRenameRewrite`. */
const RENAMED = "\n[[D]]";

beforeEach(() => {
  vi.useFakeTimers();
  // A deleted note's write fails, and says so: not this test's point.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type TC = Parameters<Parameters<typeof hegel.testAsync>[0]>[0];

/** One scenario of the export, each moment drawn from `tc`: the
 * property's body, and a counter-example's replay. */
const exportScenario = async (tc: TC): Promise<void> => {
  // The view's document, and another device's, which may hold
  // versions the view doesn't have yet.
  const doc = new LoroDoc();
  doc.setPeerId(1n);
  const other = new LoroDoc();
  other.setPeerId(2n);
  const start = tc.draw(
    gs.sampledFrom<Start>(["new", "current", "older", "unknown", "edited"]),
  );
  const exportOf = (from: LoroDoc) =>
    writeHeader(textOf(from), {
      document: DOCUMENT,
      version: formatVersion(from.frontiers()),
    });
  let initial: string;
  if (start === "new") {
    initial = exportOf(doc);
  } else {
    edit(tc, doc);
    if (start === "unknown") {
      other.import(doc.export({ mode: "snapshot" }));
      edit(tc, other);
      initial = exportOf(other);
    } else {
      initial = exportOf(doc);
      if (start === "older") edit(tc, doc);
      if (start === "edited") {
        const { content } = readHeader(initial);
        initial = initial.replace(content, `${content}edited`);
      }
    }
  }
  const vault = new FakeVault(initial);
  let unlinked = false;
  let lastWritten: string | undefined;
  let lastVersion: string | undefined;
  const problems: string[] = [];
  /** Copies asked for, not made yet; files whose copy is made. */
  const keeping: { text: string; done: () => void }[] = [];
  const keptFiles = new Set<string>();
  const outsides: Outside[] = [];
  /** The changes recognized (LK5): never kept in a copy. */
  const recognized = new Set<string>();
  // The vault's image files, the setting, the images asked of the view.
  const files = new Map<string, ImageFormat>();
  let enabled = true;
  let deletedAny = false;
  let writerStopped = false;
  const opening: {
    id: string;
    resolve: (
      image: { format: ImageFormat; bytes: Uint8Array } | undefined,
    ) => void;
  }[] = [];
  const noteOf = (text: string) =>
    toNote(text, DOCUMENT, FOLDER, (id) =>
      enabled ? files.get(id) : undefined,
    );
  const citesNoFile = (text: string, where: string) => {
    if (text.includes(`images/${DOCUMENT}/`)) {
      problems.push(`VI5: ${where} cites a file`);
    }
  };

  // Told of each import from the server, as the view tells it
  // (`MountedView.imported`): Loro says nothing of operations that leave
  // the text as it was.
  const importers = new Set<() => void>();
  const receive = () => {
    doc.import(other.export({ mode: "update" }));
    for (const told of importers) told();
  };
  const exporter = new NoteExporter({
    doc,
    documentId: DOCUMENT,
    file: () => (vault.deleted ? undefined : vault.file),
    process: (file, fn) => vault.process(file, fn),
    keep: (text) => {
      if (recognized.has(text)) {
        problems.push("LK5: recognized, then kept in a copy");
      }
      // ME2: a copy is no linked note.
      if (readLooseHeader(text).document !== undefined) {
        problems.push("ME2: a copy carries collab-document");
      }
      const file = vault.text;
      return new Promise((resolve) =>
        keeping.push({
          text,
          done: () => {
            keptFiles.add(file);
            resolve(`copy ${keptFiles.size}`);
          },
        }),
      );
    },
    onOutside: (outside) => {
      citesNoFile(outside.text, "a change kept");
      outsides.push(outside);
    },
    recognize: (exported, found) => found === `${exported}${RENAMED}`,
    onRecognized: (outside) => {
      // LK5: exactly the export of its base, rewritten — resumed from
      // there, it replays the rewrite and nothing else; taken as it is,
      // written over freely, like a copy.
      const base = formatVersion(outside.base ?? []);
      if (
        !holds(doc, base) ||
        outside.text !== `${textAt(doc, base)}${RENAMED}`
      ) {
        problems.push("LK5: recognized, not its base's export rewritten");
      }
      if (outside.copy !== "") problems.push("LK5: recognized, copied");
      citesNoFile(outside.text, "a change recognized");
      keptFiles.add(vault.text);
      recognized.add(outside.text);
      outsides.push(outside);
    },
    imported: (told) => {
      importers.add(told);
      return () => importers.delete(told);
    },
    toNote: noteOf,
    toDocument: (text) => toDocument(text, DOCUMENT),
    exported: (text) => writer.cited(notedImages(text)),
    delayMs: DELAY,
  });
  const writer: ImageWriter = new ImageWriter({
    enabled: () => enabled,
    found: (id) => files.get(id),
    image: (id) => new Promise((resolve) => opening.push({ id, resolve })),
    create: async (id, image) => {
      if (writerStopped) problems.push("VI4: a file created after stopping");
      if (files.has(id)) throw new Error("name taken");
      files.set(id, image.format);
    },
    written: () => exporter.changed(),
  });
  exporter.start();

  /** Whether `file` is the export of a version `doc` holds. */
  const isExport = (file: string) => {
    const { content, document, version } = readLooseHeader(file);
    return (
      document === DOCUMENT &&
      version !== undefined &&
      holds(doc, version) &&
      toDocument(textAt(doc, version) ?? "", DOCUMENT) ===
        toDocument(content, DOCUMENT)
    );
  };

  /** Ends a pending `process`: Obsidian reads, the exporter's
   * function decides, Obsidian writes. */
  const complete = (at: number) => {
    const [call] = vault.pending.splice(at, 1);
    if (!call) return;
    if (vault.deleted) {
      call.reject(new Error("file gone"));
      return;
    }
    const before = vault.text;
    const next = call.fn(before);
    if (next !== before) {
      // ME1: only over an export, or a file already kept.
      if (
        before !== lastWritten &&
        !keptFiles.has(before) &&
        !isExport(before)
      ) {
        problems.push("ME1: written over a change from outside not kept");
      }
      if (unlinked) problems.push("NE5: written after unlinking");
      const { content, header } = readHeader(next);
      if (!header) problems.push("written without its header");
      else {
        // NE2, VI1: its version's text, citing the files there now.
        if (noteOf(textAt(doc, header.version) ?? "\u0000") !== content) {
          problems.push("NE2, VI1: the text isn't its version's");
        }
        const version = parseVersion(header.version) ?? [];
        const previous = parseVersion(lastVersion ?? "") ?? [];
        if (
          lastVersion !== undefined &&
          (doc.cmpFrontiers(version, previous) ?? -1) < 0
        ) {
          problems.push("NE3: an older version written after a newer");
        }
        lastVersion = header.version;
      }
      lastWritten = next;
    }
    vault.text = next;
    call.resolve(next);
  };

  /** Resumes the last change kept with a base, as the view does. */
  const resume = async (times: number) => {
    const outside = [...outsides].reverse().find((o) => o.base !== undefined);
    if (!outside?.base) return;
    const { base, text } = outside;
    const quietSince = doc.cmpFrontiers(doc.frontiers(), base) === 0;
    for (let n = 0; n < times; n++) {
      // Each click, or each device, draws its peer again.
      const peer = await resumePeer(DOCUMENT, base, text);
      const change = resumeChange(doc, base, text, peer);
      // ME3: a change from the base, to the file's text — never
      // from the current state.
      const atBase = doc.forkAt(base);
      atBase.import(change);
      if (textOf(atBase) !== text) {
        problems.push("ME3: the change is not from its base");
      }
      const before = doc.oplogVersion();
      doc.import(change);
      // ME4: the same change, again, adds nothing.
      if (n > 0 && doc.oplogVersion().compare(before) !== 0) {
        problems.push("ME4: a change resumed twice entered twice");
      }
    }
    // ME3: without concurrency since the base, the file's text.
    if (quietSince && textOf(doc) !== text) {
      problems.push("ME3: resumed without concurrency, not the text");
    }
  };

  /** A change from outside to the file as it is now. */
  const changeOutside = (how: Change) => {
    const { content } = readLooseHeader(vault.text);
    if (how === "text") vault.text = `${vault.text}\nfrom outside`;
    else if (how === "reformat") vault.text = vault.text.replace(/"/g, "");
    else if (how === "noHeader") vault.text = `${content}\nno header`;
    else if (how === "linkRenamed") vault.text = `${vault.text}${RENAMED}`;
    else {
      vault.text = writeHeader(`${textOf(other)} edited elsewhere`, {
        document: DOCUMENT,
        version: formatVersion(other.frontiers()),
      });
    }
  };

  /** Puts an image in the document, at its end: its identifier. */
  const citeImage = () => {
    const id = tc.draw(gs.sampledFrom(IMAGES));
    const text = doc.getText("content");
    text.insert(text.length, ` ![i](attachment:${id}) `);
    doc.commit();
    return id;
  };
  /** The export's timer, then every write under way, ended. */
  const settle = async () => {
    await vi.advanceTimersByTimeAsync(DELAY);
    while (vault.pending.length > 0) {
      complete(0);
      await vi.advanceTimersByTimeAsync(0);
    }
  };

  let closing: Promise<void> | undefined;
  let closedAt: ReturnType<LoroDoc["frontiers"]> | undefined;
  for (let step = 0; step < 40; step++) {
    const moves: Move[] = ["timer", "otherTypes"];
    if (!closing) moves.push("type", "remote");
    if (vault.pending.length > 0) moves.push("complete");
    if (keeping.length > 0) moves.push("kept");
    if (!vault.deleted && !closing) {
      moves.push(
        "outside",
        "outsideKept",
        "renameRewrite",
        "sync",
        "syncAhead",
        "modify",
        "rename",
        "delete",
      );
    }
    if (!closing && outsides.some(({ base }) => base)) {
      moves.push("resume", "resumeTwice");
    }
    if (!unlinked && !closing) moves.push("unlink", "close");
    if (!unlinked && !closing && vault.pending.length > 0) {
      moves.push("unlinkWhileWriting");
    }
    if (opening.length > 0) moves.push("imageOpens", "imageFails");
    if (files.size > 0) moves.push("fileDeleted");
    if (!vault.deleted && !closing) moves.push("fileSynced", "syncFiles");
    if (!closing) moves.push("toggle");
    if (!vault.deleted && !closing) {
      moves.push("filesSyncedFound", "outsideOnFiles");
    }
    if (!unlinked && !closing) moves.push("stopWhileOpening");
    const move = tc.draw(gs.sampledFrom(moves));
    if (move === "type") edit(tc, doc);
    else if (move === "otherTypes") edit(tc, other);
    else if (move === "remote") {
      receive();
    } else if (move === "timer") {
      await vi.advanceTimersByTimeAsync(
        tc.draw(gs.sampledFrom([0, 300, DELAY])),
      );
    } else if (move === "complete") {
      complete(
        tc.draw(
          gs.integers({
            minValue: 0,
            maxValue: vault.pending.length - 1,
          }),
        ),
      );
    } else if (move === "kept") {
      const at = tc.draw(
        gs.integers({ minValue: 0, maxValue: keeping.length - 1 }),
      );
      keeping.splice(at, 1)[0]?.done();
    } else if (move === "outside") {
      changeOutside(
        tc.draw(
          gs.sampledFrom<Change>([
            "text",
            "reformat",
            "noHeader",
            "unknownVersion",
            "linkRenamed",
          ]),
        ),
      );
      if (tc.draw(gs.booleans())) exporter.noticed(vault.text);
    } else if (move === "outsideKept") {
      // One gesture: the file changed outside, noticed, the
      // export's write finds it, and its copy is made — what a
      // resume needs, too long a sequence for chance.
      changeOutside("text");
      exporter.noticed(vault.text);
      await vi.advanceTimersByTimeAsync(DELAY);
      if (vault.pending.length > 0) complete(vault.pending.length - 1);
      await vi.advanceTimersByTimeAsync(0);
      keeping.shift()?.done();
    } else if (move === "renameRewrite") {
      // One gesture (as `outsideKept`): Obsidian rewrites the file
      // for a renamed note, the export's write finds it (phase 19,
      // decision 10) — too long a sequence for chance.
      // The export settled first: a view's first export is written
      // as it opens, before Obsidian can rewrite anything.
      await vi.advanceTimersByTimeAsync(DELAY);
      while (vault.pending.length > 0) {
        complete(0);
        await vi.advanceTimersByTimeAsync(0);
      }
      changeOutside("linkRenamed");
      exporter.noticed(vault.text);
      await vi.advanceTimersByTimeAsync(DELAY);
      if (vault.pending.length > 0) complete(vault.pending.length - 1);
      await vi.advanceTimersByTimeAsync(0);
    } else if (move === "sync") {
      // Another device's export, of a version maybe not here yet.
      vault.text = exportOf(other);
      exporter.noticed(vault.text);
    } else if (move === "syncAhead") {
      // One gesture: the other device types, its export arrives
      // before its operations, and the export's timer fires.
      edit(tc, other);
      vault.text = exportOf(other);
      exporter.noticed(vault.text);
      await vi.advanceTimersByTimeAsync(DELAY);
      if (vault.pending.length > 0) complete(0);
    } else if (move === "modify") {
      exporter.noticed(vault.text);
    } else if (move === "resume" || move === "resumeTwice") {
      await resume(move === "resume" ? 1 : 2);
    } else if (move === "rename") {
      vault.file.path = `Collab Link/Renamed ${step}.md`;
    } else if (move === "delete") {
      vault.deleted = true;
    } else if (move === "imageOpens" || move === "imageFails") {
      const at = tc.draw(
        gs.integers({ minValue: 0, maxValue: opening.length - 1 }),
      );
      opening
        .splice(at, 1)[0]
        ?.resolve(
          move === "imageOpens"
            ? { format: "png", bytes: Uint8Array.of(1) }
            : undefined,
        );
    } else if (move === "fileDeleted") {
      files.delete(tc.draw(gs.sampledFrom([...files.keys()])));
      deletedAny = true;
    } else if (move === "fileSynced") {
      // Another device wrote the file; a sync brings it.
      files.set(tc.draw(gs.sampledFrom(IMAGES)), "png");
    } else if (move === "syncFiles") {
      // Another device's export, citing files this one may not have.
      vault.text = writeHeader(
        toNote(textOf(other), DOCUMENT, FOLDER, () => "png"),
        { document: DOCUMENT, version: formatVersion(other.frontiers()) },
      );
      exporter.noticed(vault.text);
    } else if (move === "filesSyncedFound") {
      // One gesture (as `syncAhead`): the document cites an image, the
      // other device has it, its export citing the file arrives, and the
      // export's write finds it — an export, never a copy (VI3).
      citeImage();
      other.import(doc.export({ mode: "update" }));
      vault.text = writeHeader(
        toNote(textOf(other), DOCUMENT, FOLDER, () => "png"),
        { document: DOCUMENT, version: formatVersion(other.frontiers()) },
      );
      exporter.noticed(vault.text);
      await settle();
    } else if (move === "outsideOnFiles") {
      // One gesture: an export citing a file, changed outside, kept —
      // what is resumed then cites `attachment:` (VI5).
      const id = citeImage();
      files.set(id, "png");
      await settle();
      changeOutside("text");
      exporter.noticed(vault.text);
      await vi.advanceTimersByTimeAsync(DELAY);
      if (vault.pending.length > 0) complete(vault.pending.length - 1);
      await vi.advanceTimersByTimeAsync(0);
      keeping.shift()?.done();
    } else if (move === "stopWhileOpening") {
      // One gesture: the writer waits for an image, the view closes or
      // is unlinked, then the image opens (VI4).
      citeImage();
      await settle();
      if (tc.draw(gs.booleans())) {
        closedAt = doc.frontiers();
        writerStopped = true;
        void writer.stop();
        closing = exporter.close();
      } else {
        unlinked = true;
        writerStopped = true;
        void writer.stop();
        void exporter.stop();
      }
      for (const { resolve } of opening.splice(0)) {
        resolve({ format: "png", bytes: Uint8Array.of(1) });
      }
    } else if (move === "toggle") {
      enabled = !enabled;
      exporter.changed();
    } else if (move === "unlink") {
      unlinked = true;
      writerStopped = true;
      void writer.stop();
      void exporter.stop();
    } else if (move === "unlinkWhileWriting") {
      // One gesture: a write under way, "Unlink", a keystroke, then
      // the write ends — too precise for chance (AGENTS.md §1.6).
      unlinked = true;
      writerStopped = true;
      void writer.stop();
      void exporter.stop();
      edit(tc, doc);
      complete(0);
    } else if (move === "close") {
      closedAt = doc.frontiers();
      writerStopped = true;
      void writer.stop();
      closing = exporter.close();
    }
    await vi.advanceTimersByTimeAsync(0);
    other.import(doc.export({ mode: "update" }));
  }

  // Rest: every version reaches this device (none waits any more),
  // every write and copy ends, every timer fires.
  if (!closing) receive();
  for (
    let turn = 0;
    vault.pending.length > 0 ||
    keeping.length > 0 ||
    opening.length > 0 ||
    vi.getTimerCount() > 0;
    turn++
  ) {
    if (turn > 100) throw new Error("the export never rests");
    if (vault.pending.length > 0) complete(0);
    opening.shift()?.resolve({ format: "png", bytes: Uint8Array.of(1) });
    keeping.shift()?.done();
    await vi.advanceTimersByTimeAsync(DELAY);
  }
  await closing;

  expect(problems).toEqual([]);
  // OI2: an export — another device's, of a version received late,
  // or reformatted — is never kept as a change from outside: its
  // resuming would bring the same operations again.
  for (const file of keptFiles) expect(isExport(file)).toBe(false);
  const quiet = !unlinked && !vault.deleted;
  if (quiet && !closing) {
    // NE1, OI4: at rest, the export of the last version — a change
    // from outside kept, not frozen —, citing the files there (VI1),
    // unless one was deleted by hand since (analysis 32, VA7).
    const expected = writeHeader(noteOf(textOf(doc)), {
      document: DOCUMENT,
      version: formatVersion(doc.frontiers()),
    });
    if (deletedAny) {
      expect(toDocument(vault.text, DOCUMENT)).toBe(
        toDocument(expected, DOCUMENT),
      );
    } else expect(vault.text).toBe(expected);
  }
  if (quiet && closedAt) {
    // Closed: the file holds at least what the view held then, but
    // for the export of a version it hadn't received (ME6).
    const { version } = readLooseHeader(vault.text);
    if (version !== undefined && holds(doc, version)) {
      expect(isExport(vault.text)).toBe(true);
      expect(
        doc.cmpFrontiers(parseVersion(version) ?? [], closedAt),
      ).toBeGreaterThanOrEqual(0);
    }
  }
  exporter.stop();
};

/** A `tc` that gives back recorded draws, in order (Hegel prints them as
 * `draw_1`, `draw_2`… when a case fails). */
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

describe("the linked note's export", () => {
  test("whatever happens when, the file is the export of the last version, never written over a change from outside not kept, nor after unlinking", async () => {
    await hegel.testAsync(exportScenario, { testCases: 300 });
  }, 300_000);

  // Found on 2026-10-23 (phase 19c, by a mutation measure; no rename in
  // it): the case Hegel shrank to, kept here rather than only in
  // .hegel/examples. A new note, timers, a change from outside kept, a
  // write, three imports from another device, another change from
  // outside kept: at rest, the file isn't the export of the last version
  // (NE1).
  // Found on 2026-10-23 (phase 19c, by the scenario once the rename's
  // rewrite was in it), kept as the one above.
  test("a counter-example kept: a change from outside kept, another device's export, imports, then a rename's rewrite", async () => {
    const { tc, done } = replay([
      "new",
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "remote",
      "outsideKept",
      "sync",
      "timer",
      0,
      "complete",
      0,
      "remote",
      "remote",
      "remote",
      "remote",
      "remote",
      "remote",
      "remote",
      "remote",
      "remote",
      "remote",
      "renameRewrite",
    ]);
    await exportScenario(tc);
    expect(done()).toBe(true);
  }, 60_000);

  test("a counter-example kept: two changes from outside kept around three imports", async () => {
    const { tc, done } = replay([
      "new",
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "timer",
      0,
      "outsideKept",
      "complete",
      0,
      "remote",
      "remote",
      "remote",
      "outsideKept",
    ]);
    await exportScenario(tc);
    expect(done()).toBe(true);
  }, 60_000);

  // Found on 2026-11-07, by the scenario (no mutation, nothing changed in
  // the exporter): its 40 steps, all but the last three a timer of 0 ms.
  // Another device types, its export arrives before its operations, then
  // a change from outside kept: at rest, the file isn't the export of the
  // last version (NE1). Its operations, typing and deleting, left the
  // text as it was: Loro said nothing, and the export, left for their
  // version, waited for them forever; now told of each import.
  test("a counter-example kept: another device's export ahead of its operations, then a change from outside kept", async () => {
    const { tc, done } = replay([
      "new",
      ...Array.from({ length: 37 }, () => ["timer", 0]).flat(),
      "otherTypes",
      0,
      "a",
      "syncAhead",
      0,
      true,
      "outsideKept",
    ]);
    await exportScenario(tc);
    expect(done()).toBe(true);
  }, 60_000);
});
