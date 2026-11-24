import type { Frontiers, LoroDoc } from "loro-crdt";
import { count } from "../../web/lib/src/index.js";
import {
  formatVersion,
  parseVersion,
  readLooseHeader,
  writeHeader,
} from "./note-header.js";

/** The export's delay: at most this long after the first change not yet
 * exported (like the local save, ADR-0022 point 2). */
export const EXPORT_DELAY_MS = 1000;

/** A change from outside, once kept: the copy's name, its text (the file
 * without the two properties, brought back to the document's, ADR-0058 §3), and
 * the version it changed, when known — what "Resume this change" starts from.
 */
export interface Outside {
  copy: string;
  text: string;
  base: Frontiers | undefined;
}

/** What the file is, to the export: an export, or a text already kept, to write
 * over; the export of a version the document doesn't hold yet, to leave; or a
 * change from outside, to keep first. */
type FileState = "export" | "later" | { base: Frontiers | undefined };

/** Keeps a linked note's file the export of its document
 * (docs/phase-14-plugin-obsidian.md, decisions 3 and 4): written at most
 * `delayMs` after the first change, one write at a time, text and version read
 * together when Obsidian hands the file over (NE2, NE3); never over a change
 * from outside before it is kept in a copy (ME1), nor after `stop` (NE5). */
export class NoteExporter<File> {
  private readonly doc: LoroDoc;
  private readonly documentId: string;
  private readonly file: () => File | undefined;
  private readonly process: (
    file: File,
    fn: (current: string) => string,
  ) => Promise<string>;
  private readonly keep: (text: string) => Promise<string>;
  private readonly onOutside: (outside: Outside) => void;
  private readonly recognize:
    | ((exported: string, found: string) => boolean)
    | undefined;
  private readonly onRecognized: ((outside: Outside) => void) | undefined;
  private readonly delayMs: number;
  private readonly imported: ((told: () => void) => () => void) | undefined;
  private readonly toNote: (text: string) => string;
  private readonly toDocument: (text: string) => string;
  private readonly exported: ((text: string) => void) | undefined;
  private readonly setTimer: (run: () => void, ms: number) => () => void;
  /** Cancels the export's timer, while it runs. */
  private timer: (() => void) | undefined;
  private writing: Promise<void> = Promise.resolve();
  /** The last file written, and its version, once the export wrote one. */
  private last: string | undefined;
  private lastVersion: Frontiers | undefined;
  /** Files from outside already kept in a copy: written over freely. */
  private readonly kept = new Set<string>();
  private stopped = false;
  private unsubscribe: (() => void) | undefined;
  private unsubscribeImports: (() => void) | undefined;

  constructor(options: {
    doc: LoroDoc;
    documentId: string;
    /** The note now — renamed, its new one —; none once deleted. */
    file: () => File | undefined;
    /** Obsidian's `vault.process`: reads and writes in one operation. */
    process: (file: File, fn: (current: string) => string) => Promise<string>;
    /** Keeps a change from outside in a copy; resolves with its name. */
    keep: (text: string) => Promise<string>;
    /** A change from outside was kept, and is about to be written over. */
    onOutside: (outside: Outside) => void;
    /** Whether a change from outside, `found`, is one to take as it is rather
     * than to keep in a copy, the last export being `exported` (both without
     * the header): a rename's rewrite. */
    recognize?: (exported: string, found: string) => boolean;
    /** Such a change, with the last export's version for base: to resume
     * (ME3); about to be written over. */
    onRecognized?: (outside: Outside) => void;
    /** Tells at each import from the server, its text changed or not: Loro says
     * nothing of operations that leave the text as it was, and a file left for
     * a version not here yet ("later", ME6) waits for them. Returns how to
     * stop. */
    imported?: (told: () => void) => () => void;
    /** The note's text of the document's (ADR-0058 §1): its images cited
     * as files of the vault, those found when the export is written. */
    toNote?: (text: string) => string;
    /** Brings a note's text back to the document's (ADR-0058 §3): what is
     * compared, and what a change from outside resumes. */
    toDocument?: (text: string) => string;
    /** The document's text, once an export of it is written. */
    exported?: (text: string) => void;
    delayMs?: number;
    /** The timers (a test's, counted); returns how to cancel. */
    setTimer?: (run: () => void, ms: number) => () => void;
  }) {
    this.doc = options.doc;
    this.documentId = options.documentId;
    this.file = options.file;
    this.process = options.process;
    this.keep = options.keep;
    this.onOutside = options.onOutside;
    this.recognize = options.recognize;
    this.onRecognized = options.onRecognized;
    this.delayMs = options.delayMs ?? EXPORT_DELAY_MS;
    this.setTimer =
      options.setTimer ??
      ((run, ms) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      });
    this.imported = options.imported;
    this.toNote = options.toNote ?? ((text) => text);
    this.toDocument = options.toDocument ?? ((text) => text);
    this.exported = options.exported;
  }

  /** Follows the document, and brings an older export up to date. */
  start(): void {
    this.unsubscribe = this.doc.subscribe(() => this.changed());
    this.unsubscribeImports = this.imported?.(() => this.changed());
    this.changed();
  }

  /** The document changed: exported at most `delayMs` from now. */
  changed(): void {
    if (this.stopped || this.timer !== undefined) return;
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      void this.write();
    }, this.delayMs);
  }

  /** The file changed, to `text`: unless it is the export's own, looked at
   * within `delayMs` — a change from outside already kept too, which is written
   * over without another copy (the same change made twice stayed in the file).
   */
  noticed(text: string): void {
    if (text === this.last) return;
    this.changed();
  }

  /** Writes now, and resolves once every write asked for is done. */
  flush(): Promise<void> {
    this.cancelTimer();
    return this.write();
  }

  /** The view closes: the last export, then nothing more. */
  async close(): Promise<void> {
    await this.flush();
    await this.stop();
  }

  /** Nothing written after this ("Unlink", a deleted note); resolves once
   * a write under way has ended. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelTimer();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubscribeImports?.();
    this.unsubscribeImports = undefined;
    await this.writing;
  }

  private cancelTimer(): void {
    this.timer?.();
    this.timer = undefined;
  }

  /** One write at a time (NE3), after those asked for before. */
  private write(): Promise<void> {
    this.writing = this.writing.then(() => this.writeOnce());
    return this.writing;
  }

  /** Writes the export; a change from outside found instead is kept
   * first, then looked at again — kept, or changed once more. */
  private async writeOnce(): Promise<void> {
    for (;;) {
      const file = this.file();
      if (this.stopped || file === undefined) return;
      let found: { text: string; base: Frontiers | undefined } | undefined;
      let written: string | undefined;
      try {
        await this.process(file, (current) => {
          // Read here, in the operation that writes: text and version
          // together (NE2), and the file as it is now (ME1).
          found = undefined;
          if (this.stopped) return current;
          const state = this.stateOf(current);
          if (state === "later") return current;
          if (state !== "export") {
            found = { text: current, base: state.base };
            return current;
          }
          const frontiers = this.doc.frontiers();
          written = this.doc.getText("content").toString();
          const next = writeHeader(this.toNote(written), {
            document: this.documentId,
            version: formatVersion(frontiers),
          });
          if (next !== current) count("export.write");
          this.last = next;
          this.lastVersion = frontiers;
          return next;
        });
      } catch (error) {
        // The note was deleted meanwhile: nothing to write to.
        console.warn("collab-link: export not written", error);
        return;
      }
      const outside: { text: string; base: Frontiers | undefined } | undefined =
        found;
      if (!outside) {
        if (written !== undefined) this.exported?.(written);
        return;
      }
      const { content } = readLooseHeader(outside.text);
      // A rename's rewrite of the last export, its version for base: taken as
      // it is, no copy (LK5).
      const exported =
        this.last === undefined ? undefined : readLooseHeader(this.last);
      if (
        exported &&
        outside.base &&
        this.lastVersion &&
        sameFrontiers(outside.base, this.lastVersion) &&
        this.recognize?.(exported.content, content)
      ) {
        this.kept.add(outside.text);
        this.onRecognized?.({
          copy: "",
          text: this.toDocument(content),
          base: outside.base,
        });
        continue;
      }
      // OI3, ME1: kept before anything is written over it; without the
      // two properties, so that the copy is no linked note (ME2).
      let copy: string;
      try {
        copy = await this.keep(content);
      } catch (error) {
        // Not kept: not written over either, until the file changes.
        console.warn("collab-link: change from outside not kept", error);
        return;
      }
      this.kept.add(outside.text);
      this.onOutside({
        copy,
        text: this.toDocument(content),
        base: outside.base,
      });
    }
  }

  private stateOf(current: string): FileState {
    if (current === this.last || this.kept.has(current)) return "export";
    const { content, document, version } = readLooseHeader(current);
    const frontiers =
      document === this.documentId && version !== undefined
        ? parseVersion(version)
        : undefined;
    // Without a version to compare to, the last export's.
    if (!frontiers) return { base: this.lastVersion };
    const known = this.doc.oplogVersion();
    const holds = frontiers.every(
      ({ peer, counter }) => (known.get(peer) ?? 0) > counter,
    );
    // ME6: never compared to a version not received yet.
    if (!holds) return "later";
    count("export.fork");
    const then = this.doc.forkAt(frontiers).getText("content").toString();
    // An export: this device's, another's (OW5), or reformatted; its
    // images cited as files or not (ADR-0058 §3).
    return this.toDocument(then) === this.toDocument(content)
      ? "export"
      : { base: frontiers };
  }
}

/** Whether two versions are the same. */
function sameFrontiers(a: Frontiers, b: Frontiers): boolean {
  return formatVersion(a) === formatVersion(b);
}
