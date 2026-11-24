import * as hegel from "@hegeldev/hegel";
import type { TestCase } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc } from "loro-crdt";
import { afterEach, describe, test, vi } from "vitest";
import {
  computeAnnotationsView,
  suggestAddition,
  tryCreateAnnotation,
} from "../../lib/src/annotations/index.js";
import { exportMarkdown } from "./export.js";
import { parseCriticMarkup } from "./parse.js";

// Ids in creation order, the same at every run (Hegel replays).
function sequentialIds(): void {
  let next = 0;
  vi.spyOn(crypto, "randomUUID").mockImplementation(
    () =>
      `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}` as `${string}-${string}-${string}-${string}-${string}`,
  );
}
afterEach(() => vi.restoreAllMocks());

/** A document as the page makes it: annotations created one by one on
 * ranges of any width, those that would cross an open one refused
 * (ADR-0012), comments over any span, nested or not. */
function drawDocument(tc: TestCase) {
  const text = tc
    .draw(
      gs.arrays(gs.sampledFrom(["one", "two", "three", "four"]), {
        minSize: 1,
        maxSize: 8,
      }),
    )
    .join(" ");
  const contentDoc = new LoroDoc();
  contentDoc.getText("content").insert(0, text);
  contentDoc.commit();
  const annotationsDoc = new LoroDoc();
  const count = tc.draw(gs.integers({ minValue: 1, maxValue: 6 }));
  for (let i = 0; i < count; i++) {
    const type = tc.draw(
      gs.sampledFrom([
        "addition",
        "deletion",
        "substitution",
        "comment",
      ] as const),
    );
    const start = tc.draw(gs.integers({ minValue: 0, maxValue: text.length }));
    const end = tc.draw(
      gs.integers({ minValue: start, maxValue: text.length }),
    );
    const author = "alice";
    const note = tc.draw(gs.booleans()) ? { note: `n${i}` } : {};
    if (type === "addition") {
      suggestAddition(contentDoc, annotationsDoc, {
        at: start,
        text: `a${i}`,
        author,
        ...note,
      });
    } else if (type === "comment" || start < end) {
      // (a deletion or substitution of nothing is not made)
      tryCreateAnnotation(contentDoc, annotationsDoc, {
        type,
        start,
        end,
        author,
        ...(type === "substitution" && { replacement: `s${i}`, ...note }),
        ...(type === "deletion" && note),
        ...(type === "comment" && { body: `c${i}` }),
      });
    }
  }
  return { text, view: computeAnnotationsView(contentDoc, annotationsDoc) };
}

describe("exportMarkdown (property)", () => {
  test(
    "writes every open annotation it does not count as left out, and the text unchanged",
    () =>
      hegel.test(
        (tc) => {
          sequentialIds();
          const { text, view } = drawDocument(tc);
          const exported = exportMarkdown(text, view);
          // Crossing: refused; ambiguous: said so, read back it may differ.
          if (exported.kind !== "exported" || exported.ambiguous) return;
          const read = parseCriticMarkup(exported.markdown);
          const what = (a: {
            type: string;
            body?: string | undefined;
            note?: string | undefined;
            proposed?: string | undefined;
          }) =>
            JSON.stringify([
              a.type,
              // A comment's body starts with what it covers.
              (a.body ?? a.proposed ?? "").replace(/^.* — /, ""),
              a.note ?? "",
            ]);
          const written = view.annotations
            .filter((a) => a.status === "open")
            .map((a) => {
              const preview = view.previews.get(a.id);
              return what({
                ...a,
                ...(preview?.kind === "valid" && { proposed: preview.text }),
              });
            })
            .sort();
          const found = read.annotations.map(what).sort();
          // What is read back is what was open, but for what the export
          // counts as left out.
          const remaining = [...written];
          const extra = found.filter((f) => {
            const at = remaining.indexOf(f);
            if (at >= 0) remaining.splice(at, 1);
            return at < 0;
          });
          if (
            read.text !== text ||
            extra.length > 0 ||
            remaining.length !== exported.omitted
          ) {
            throw new Error(
              `markdown=${JSON.stringify(exported.markdown)}\ntext=${JSON.stringify(read.text)} (was ${JSON.stringify(text)})\nread=${found.join(" ")}\nopen=${written.join(" ")}\nomitted=${exported.omitted}`,
            );
          }
        },
        { testCases: 300 },
      ),
    60_000,
  );
});
