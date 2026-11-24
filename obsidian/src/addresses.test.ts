// An address of this server's document, opened in its note (ADR-0045),
// its order drawn by Hegel (AGENTS.md §1.6): clicks on the addresses of
// two documents, in any number; each wait of an opening — looking for the
// note, opening the link that creates it, showing it — ends when the test
// says. Checked at each step: OA1 (one opening of a document at a time,
// never two notes), OA2 (an opening never waits for another document's);
// at rest, OA3 (each click has shown its note, nothing in progress).
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { App, TFile } from "obsidian";
import { describe, expect, test } from "vitest";
import { Addresses, type AddressesHost } from "./addresses.js";

const ORIGIN = "https://collab.test";
const DOCS = ["d1", "d2"] as const;
type Doc = (typeof DOCS)[number];

/** Every microtask through. */
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A wait of an opening, of `doc`, ended when the test says. */
interface Gate {
  doc: Doc;
  go: () => void;
}

function scenario() {
  const pending: Gate[] = [];
  const notes = new Map<Doc, TFile>();
  const shown = new Map<Doc, number>();
  const problems: string[] = [];
  const running: Promise<unknown>[] = [];
  const gate = <T>(doc: Doc, value: () => T) =>
    new Promise<T>((resolve) => {
      pending.push({ doc, go: () => resolve(value()) });
    });
  const docOf = (text: string) => new URL(text).searchParams.get("doc") as Doc;
  const host = {
    app: {
      vault: { getAbstractFileByPath: () => null },
      workspace: {
        getLeaf: () => ({
          setViewState: (state: { state: { file: string } }) => {
            const doc = state.state.file.replace(/\.md$/, "") as Doc;
            return gate(doc, () => {
              shown.set(doc, (shown.get(doc) ?? 0) + 1);
            });
          },
        }),
      },
    } as unknown as App,
    settings: { serverSet: () => ORIGIN },
    unlinked: { pathOf: () => undefined },
    notes: {
      noteOf: (doc: Doc) => gate(doc, () => notes.get(doc)),
      openPasted: (link: string) => {
        const doc = docOf(link);
        return gate(doc, () => {
          if (notes.has(doc)) problems.push(`OA1: a second note of ${doc}`);
          notes.set(doc, { path: `${doc}.md` } as TFile);
        });
      },
    },
    keyring: {
      ensure: () => Promise.resolve(undefined),
      current: () =>
        Promise.resolve({
          entries: () =>
            DOCS.map((doc) => ({
              documentId: doc,
              link: `${ORIGIN}/?doc=${doc}#k=key`,
            })),
        }),
      reopenSession: () => Promise.resolve(undefined),
    },
    track: <T>(work: Promise<T>) => {
      running.push(work);
      return work;
    },
  } as unknown as AddressesHost;
  return { addresses: new Addresses(host), pending, shown, problems, running };
}

describe("Addresses", () => {
  test("OA1–OA3, whatever the order of the clicks and of the openings' waits", async () => {
    await hegel.testAsync(
      async (tc) => {
        const s = scenario();
        const clicks = new Map<Doc, number>();
        const open = (() => null) as unknown as typeof window.open;
        /** OA1, OA2: each document with a click still opening has exactly
         * one wait under way. */
        const check = () => {
          for (const doc of DOCS) {
            const waits = s.pending.filter((g) => g.doc === doc).length;
            const opening = (clicks.get(doc) ?? 0) - (s.shown.get(doc) ?? 0);
            if (waits > 1) s.problems.push(`OA1: ${doc} opened twice at once`);
            if (opening > 0 && waits === 0) {
              s.problems.push(`OA2: ${doc} waits for another document`);
            }
          }
          expect(s.problems).toEqual([]);
        };
        const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 14 }));
        for (let i = 0; i < steps; i++) {
          const move = tc.draw(gs.sampledFrom(["click", "end"] as const));
          if (move === "click" || s.pending.length === 0) {
            const doc = tc.draw(gs.sampledFrom(DOCS));
            clicks.set(doc, (clicks.get(doc) ?? 0) + 1);
            expect(s.addresses.follow(`${ORIGIN}/?doc=${doc}`, open)).toBe(
              true,
            );
          } else {
            const at = tc.draw(
              gs.integers({ minValue: 0, maxValue: s.pending.length - 1 }),
            );
            const [ended] = s.pending.splice(at, 1);
            ended?.go();
          }
          await turn();
          check();
        }
        // At rest: every wait ended, in order.
        while (s.pending.length > 0) {
          s.pending.shift()?.go();
          await turn();
          check();
        }
        await Promise.all(s.running);
        // OA3: each click has shown its note.
        for (const doc of DOCS) {
          expect(s.shown.get(doc) ?? 0).toBe(clicks.get(doc) ?? 0);
        }
      },
      { testCases: 400 },
    );
  }, 300_000);
});
