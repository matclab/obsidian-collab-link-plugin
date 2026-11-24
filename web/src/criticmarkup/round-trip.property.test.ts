import * as hegel from "@hegeldev/hegel";
import type { TestCase } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import type { AnnotationType } from "../../lib/src/annotations/model.js";
import { type ResolvedAnnotation, formatCriticMarkup } from "./format.js";
import { parseCriticMarkup } from "./parse.js";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz";
// Leaf types can't have anything nested inside them (parse.ts treats their
// content as plain text, matching real CriticMarkup: comment bodies and
// substitution old/new text never contain further markers; an addition's
// text is not in content at all, ADR-0018).
const LEAF_TYPES: readonly AnnotationType[] = ["substitution", "addition"];
// A comment's highlight holds what its range holds (ADR-0034 §1).
const CONTAINER_TYPES: readonly AnnotationType[] = ["deletion", "comment"];

let nextId = 0;

/** A generated annotation still missing its final `range` (set once the
 * surrounding slot's position is known) — `width` drives generation only. */
interface Draft {
  type: AnnotationType;
  width: number;
  child?: Draft;
}

function drawDraft(tc: TestCase, allowChild: boolean): Draft {
  const type = tc.draw(
    gs.sampledFrom([...CONTAINER_TYPES, ...LEAF_TYPES] as const),
  );
  // A comment's range round-trips since ADR-0034 (in `{==…==}`), an empty
  // one too (its reference alone). An addition is a point (ADR-0018).
  const width =
    type === "addition"
      ? 0
      : tc.draw(
          gs.integers({ minValue: type === "comment" ? 0 : 1, maxValue: 5 }),
        );
  const draft: Draft = { type, width };
  if (allowChild && CONTAINER_TYPES.includes(type) && width >= 2) {
    if (tc.draw(gs.booleans())) {
      draft.child = drawDraft(tc, false);
    }
  }
  return draft;
}

/** Places drafts at disjoint positions (at least 1 gap char apart, to avoid
 * the touching-boundary edge case, orthogonal to what this property is
 * about — see overlap.property.test.ts for boundary classification) inside
 * `[0, textLength)`, then resolves each into a `ResolvedAnnotation`,
 * recursing into `child` at an offset strictly inside its parent. */
function place(
  tc: TestCase,
  drafts: readonly Draft[],
  text: string,
): ResolvedAnnotation[] {
  const textLength = text.length;
  const result: ResolvedAnnotation[] = [];
  let cursor = 0;
  for (const draft of drafts) {
    const remaining = textLength - cursor;
    if (remaining < draft.width) break; // ran out of room; just drop it
    const gapBudget = remaining - draft.width;
    const gap = tc.draw(gs.integers({ minValue: 0, maxValue: gapBudget }));
    const start = cursor + gap;
    const end = start + draft.width;
    cursor = end + 1; // +1 keeps a gap before the next sibling
    result.push(...resolve(tc, text, draft, start, end));
  }
  return result;
}

/** Resolves `draft` (and, recursively, its `child`) into a flat list of
 * `ResolvedAnnotation`s, all sharing `[start, end)` as the outermost slot. */
function resolve(
  tc: TestCase,
  text: string,
  draft: Draft,
  start: number,
  end: number,
): ResolvedAnnotation[] {
  const annotation: ResolvedAnnotation = {
    id: `a${nextId++}`,
    type: draft.type,
    author: "alice",
    status: "open",
    createdAt: 0,
    replies: [],
    range: { start, end },
  };
  if (draft.type === "substitution" || draft.type === "addition") {
    annotation.proposed = tc.draw(
      gs.text({ minSize: 1, maxSize: 8, alphabet: ALPHABET }),
    );
  }
  if (draft.type !== "comment" && tc.draw(gs.booleans())) {
    annotation.note = tc.draw(
      gs.text({ minSize: 1, maxSize: 8, alphabet: ALPHABET }),
    );
  }
  if (draft.type === "comment") {
    annotation.body = tc.draw(
      gs.text({ minSize: 1, maxSize: 8, alphabet: ALPHABET }),
    );
  }
  const flat = [annotation];
  // Strictly inside the parent, leaving at least 1 boundary char on each
  // side so parent and child never share an exact boundary (touching
  // boundaries are exercised separately by overlap.property.test.ts).
  if (draft.child && end - start >= 2) {
    const childStart = start + 1;
    const maxChildWidth = end - 1 - childStart;
    const childWidth =
      draft.child.type === "addition"
        ? 0
        : Math.max(
            draft.child.type === "comment" ? 0 : 1,
            Math.min(draft.child.width, maxChildWidth),
          );
    const childEnd = childStart + childWidth;
    if (childEnd < end) {
      flat.push(...resolve(tc, text, draft.child, childStart, childEnd));
    }
  }
  return flat;
}

describe("CriticMarkup round-trip (property)", () => {
  test("parseCriticMarkup(formatCriticMarkup(text, annotations)) restores the same text and annotations", () =>
    hegel.testAsync(async (tc) => {
      const text = tc.draw(
        gs.text({ minSize: 10, maxSize: 60, alphabet: ALPHABET }),
      );
      const draftCount = tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
      const drafts = Array.from({ length: draftCount }, () =>
        drawDraft(tc, true),
      );
      const annotations = place(tc, drafts, text);

      const formatted = formatCriticMarkup(text, annotations);
      const result = parseCriticMarkup(formatted);

      if (result.text !== text) {
        throw new Error(
          `text diverged: original=${JSON.stringify(text)} got=${JSON.stringify(result.text)} formatted=${JSON.stringify(formatted)}`,
        );
      }

      // The author and the date come back too, from the notes (ADR-0034).
      const comparable = (a: {
        type: string;
        start: number;
        end: number;
        proposed?: string;
        body?: string;
        note?: string;
        author?: string;
        createdAt?: number;
      }) => ({
        type: a.type,
        start: a.start,
        end: a.end,
        proposed: a.proposed,
        body: a.body,
        note: a.note,
        author: a.author,
        createdAt: a.createdAt,
      });
      const order = (a: { start: number; type: string }, b: typeof a) =>
        a.start - b.start || a.type.localeCompare(b.type);
      const expected = annotations
        .map((a) =>
          comparable({ ...a, start: a.range.start, end: a.range.end }),
        )
        .sort(order);
      const actual = result.annotations.map(comparable).sort(order);

      if (result.notices.length > 0) {
        throw new Error(`our own export needed notices: ${formatted}`);
      }
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(
          `annotations diverged: expected=${JSON.stringify(expected)} got=${JSON.stringify(actual)} formatted=${JSON.stringify(formatted)}`,
        );
      }
    }));
});
