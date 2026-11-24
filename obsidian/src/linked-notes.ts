import type { TFile, Vault } from "obsidian";
import { readLooseHeader } from "./note-header.js";

/** The vault's linked notes, by the document their header names (read
 * loosely: however another tool rewrote it), kept as the vault changes,
 * in place of a read of the whole vault at each opening. LN1–LN3
 * (docs/phase-39-refactorisation-du-plugin.md). */
export class LinkedNotes {
  /** Each note's document, by path. */
  private readonly documents = new Map<string, string>();
  /** The last read asked for each path: only it is written (LN1). */
  private readonly latest = new Map<string, number>();
  private reads = 0;
  private reading = 0;
  private waiting: (() => void)[] = [];
  /** Resolves once `start` has run: no answer before. */
  private readonly started: Promise<void>;
  private begin = () => {};

  constructor(
    private readonly vault: Pick<Vault, "getMarkdownFiles" | "cachedRead">,
  ) {
    this.started = new Promise((resolve) => {
      this.begin = resolve;
    });
  }

  /** Every note read once. */
  start(): void {
    for (const file of this.vault.getMarkdownFiles()) this.look(file);
    this.begin();
  }

  /** `file` created or changed: read again. */
  look(file: TFile): void {
    if (file.extension !== "md") return;
    const { path } = file;
    const read = ++this.reads;
    this.latest.set(path, read);
    this.reading++;
    void this.vault
      .cachedRead(file)
      .then(
        (text) => {
          if (this.latest.get(path) !== read) return;
          const { document } = readLooseHeader(text);
          if (document === undefined) this.documents.delete(path);
          else this.documents.set(path, document);
        },
        () => {},
      )
      .finally(() => {
        if (--this.reading > 0) return;
        for (const resolve of this.waiting.splice(0)) resolve();
      });
  }

  /** `file`, renamed from `from`: under its new path, read again (LN3). */
  renamed(file: TFile, from: string): void {
    const document = this.documents.get(from);
    this.forget(from);
    if (document !== undefined) this.documents.set(file.path, document);
    this.look(file);
  }

  /** The note at `path` is gone (LN3). */
  forget(path: string): void {
    this.documents.delete(path);
    this.latest.delete(path);
  }

  /** Resolves once no read is in progress (LN2). */
  async idle(): Promise<void> {
    await this.started;
    while (this.reading > 0) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
  }

  /** The note linked to `documentId`, the first in the vault's order. */
  async noteOf(documentId: string): Promise<TFile | undefined> {
    await this.idle();
    return this.vault
      .getMarkdownFiles()
      .find((file) => this.documents.get(file.path) === documentId);
  }

  /** The linked notes, in the vault's order. */
  async linked(): Promise<TFile[]> {
    await this.idle();
    return this.vault
      .getMarkdownFiles()
      .filter((file) => this.documents.has(file.path));
  }
}
