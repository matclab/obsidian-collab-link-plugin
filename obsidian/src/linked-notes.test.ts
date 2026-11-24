// The index of the vault's linked notes, its order drawn by Hegel
// (AGENTS.md §1.6): notes created, written (linked to a document, to
// another, or not at all), renamed, deleted, in any order; each read
// ends when the test says, with the text it was asked at — a slow one may
// end after a newer one. Checked at each answer: LN2 (the vault's first
// note that names the document now, once no read runs) and LN3 (a note
// still there); at rest, LN1 (the index is what a read of the whole vault
// says).
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { TFile } from "obsidian";
import { describe, expect, test } from "vitest";
import { LinkedNotes } from "./linked-notes.js";
import { readLooseHeader, writeHeader } from "./note-header.js";

const DOCS = ["d1", "d2"] as const;
const PATHS = ["a.md", "b.md", "c.md"] as const;

/** Every microtask through. */
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeVault() {
  /** The vault's notes, in its order, and each one's text. */
  const files: TFile[] = [];
  const texts = new Map<TFile, string>();
  /** Reads under way, each ended when the test says. */
  const reads: (() => void)[] = [];
  const vault = {
    getMarkdownFiles: () => [...files],
    cachedRead: (file: TFile) => {
      const text = texts.get(file) ?? "";
      return new Promise<string>((resolve) => {
        reads.push(() => resolve(text));
      });
    },
  };
  const at = (path: string) => files.find((file) => file.path === path);
  /** What a read of the whole vault says: the first note naming `doc`. */
  const truth = (doc: string) =>
    files.find(
      (file) => readLooseHeader(texts.get(file) ?? "").document === doc,
    );
  return { vault, files, texts, reads, at, truth };
}

const textOf = (doc: string | undefined) =>
  doc === undefined
    ? "plain"
    : writeHeader("text", { document: doc, version: "" });

describe("LinkedNotes", () => {
  test("LN1–LN3, whatever the order of the vault's changes and of the reads' ends", async () => {
    await hegel.testAsync(
      async (tc) => {
        const v = fakeVault();
        const problems: string[] = [];
        const linked = (doc: string | undefined) => textOf(doc);
        // A vault already there, read at start.
        for (const path of PATHS.slice(0, 2)) {
          const file = { path, extension: "md" } as TFile;
          v.files.push(file);
          v.texts.set(
            file,
            linked(tc.draw(gs.sampledFrom([...DOCS, undefined]))),
          );
        }
        const notes = new LinkedNotes(v.vault);
        notes.start();
        const ask = (doc: string) =>
          void notes.noteOf(doc).then((file) => {
            if (file && !v.files.includes(file)) {
              problems.push(`LN3: ${file.path} is gone`);
            }
            if (file !== v.truth(doc)) {
              problems.push(`LN2: ${doc} answered ${file?.path}`);
            }
          });
        const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 16 }));
        for (let i = 0; i < steps; i++) {
          const move = tc.draw(
            gs.sampledFrom([
              "write",
              "create",
              "rename",
              "delete",
              "end",
              "ask",
            ] as const),
          );
          const path = tc.draw(gs.sampledFrom(PATHS));
          const file = v.at(path);
          if (move === "write" && file) {
            v.texts.set(
              file,
              linked(tc.draw(gs.sampledFrom([...DOCS, undefined]))),
            );
            notes.look(file);
          } else if (move === "create" && !file) {
            const created = { path, extension: "md" } as TFile;
            v.files.push(created);
            v.texts.set(
              created,
              linked(tc.draw(gs.sampledFrom([...DOCS, undefined]))),
            );
            notes.look(created);
          } else if (move === "rename" && file) {
            const to = tc.draw(gs.sampledFrom(PATHS));
            if (!v.at(to)) {
              const from = file.path;
              file.path = to;
              notes.renamed(file, from);
            }
          } else if (move === "delete" && file) {
            v.files.splice(v.files.indexOf(file), 1);
            notes.forget(file.path);
          } else if (move === "end" && v.reads.length > 0) {
            const at = tc.draw(
              gs.integers({ minValue: 0, maxValue: v.reads.length - 1 }),
            );
            v.reads.splice(at, 1)[0]?.();
          } else if (move === "ask") {
            ask(tc.draw(gs.sampledFrom(DOCS)));
          }
          await turn();
          expect(problems).toEqual([]);
        }
        // At rest: every read ended.
        while (v.reads.length > 0) {
          v.reads.shift()?.();
          await turn();
        }
        expect(problems).toEqual([]);
        // LN1: the index is what a read of the whole vault says.
        for (const doc of DOCS) {
          expect(await notes.noteOf(doc)).toBe(v.truth(doc));
        }
        expect(await notes.linked()).toEqual(
          v.files.filter(
            (file) => readLooseHeader(v.texts.get(file) ?? "").document,
          ),
        );
      },
      { testCases: 400 },
    );
  }, 300_000);
});
