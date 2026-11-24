// The document against the specification's vectors
// (docs/protocol/03-document.md, docs/protocol/vectors.json): annotation
// entries, detached changes, decision records and their winners — the
// parts on which two clients must agree to the byte.
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { fromHex, toHex, vectors } from "../test-support/vectors.js";
import { DecisionLog, decodeProposal } from "./decisions.js";
import { checkDetachedChange, suggestionPeer } from "./detached.js";
import { listAnnotations } from "./model.js";

const { document } = vectors;

function contentDoc(): LoroDoc {
  const doc = new LoroDoc();
  doc.import(fromHex(document.content_snapshot));
  return doc;
}

/** A value with its bytes in hex: comparable to a vector. */
function comparable(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(
    JSON.stringify(value, (_, inner) =>
      inner instanceof Uint8Array ? toHex(inner) : inner,
    ),
  );
}

describe("the document, as the vectors say", () => {
  test("D-1: the content snapshot holds the text", () => {
    expect(contentDoc().getText("content").toString()).toBe(
      document.content_text,
    );
  });

  test("D-15: suggestion peers", () => {
    for (const { annotation_id, peer } of document.suggestion_peers) {
      expect(suggestionPeer(annotation_id).toString()).toBe(peer);
    }
  });

  test("D-7 to D-13: annotation entries, the malformed ones skipped", () => {
    const annotations = new LoroDoc();
    annotations.import(fromHex(document.annotations.snapshot));

    // The specification doesn't order them.
    const byId = (x: { id: string }, y: { id: string }) =>
      x.id < y.id ? -1 : 1;
    const listed = listAnnotations(contentDoc(), annotations).map(
      ({ replies, ...annotation }) => annotation,
    );
    expect(comparable(listed.sort(byId))).toEqual(
      [...document.annotations.listed].sort(byId),
    );
  });

  test("D-38, D-39: replies, the malformed ones skipped, in the list's order", () => {
    const annotations = new LoroDoc();
    annotations.import(fromHex(document.annotations.snapshot));

    expect(
      Object.fromEntries(
        listAnnotations(contentDoc(), annotations).map((a) => [
          a.id,
          a.replies,
        ]),
      ),
    ).toEqual(document.annotations.replies);
  });

  test("D-13: a range whose characters were deleted is zero-width where it was", () => {
    const { content_snapshot, ranges } = document.annotations_after_deletion;
    const content = new LoroDoc();
    content.import(fromHex(content_snapshot));
    const annotations = new LoroDoc();
    annotations.import(fromHex(document.annotations.snapshot));

    const resolved = Object.fromEntries(
      listAnnotations(content, annotations).map((a) => [a.id, a.range]),
    );
    expect(resolved).toEqual(ranges);
  });

  test("D-17: detached changes", () => {
    for (const {
      why,
      annotation_id,
      change,
      verdict,
      text,
    } of document.detached_changes) {
      const result = checkDetachedChange(
        contentDoc(),
        annotation_id,
        fromHex(change),
      );
      expect(result.kind, why).toBe(verdict);
      if (text !== undefined) expect(result).toMatchObject({ text });
    }
  });

  test("D-21 to D-25: which decision records are valid", () => {
    for (const { why, plaintext, valid } of document.decision_records) {
      expect(comparable(decodeProposal(fromHex(plaintext))), why).toEqual(
        valid,
      );
    }
  });

  test("D-26, D-27: the winners of a journal", () => {
    const log = new DecisionLog();
    log.add(
      document.decision_winners.journal.map(
        ({ seq, plaintext }: { seq: number; plaintext: string }) => ({
          seq,
          record: fromHex(plaintext),
        }),
      ),
    );
    const { suggestions, comments } = document.decision_winners;
    for (const [id, { proposalId, void: isVoid }] of Object.entries(
      suggestions as Record<string, { proposalId: string; void: boolean }>,
    )) {
      const winner = log.winner(id);
      expect(winner?.proposalId, id).toBe(proposalId);
      expect(winner?.void === true, id).toBe(isVoid);
    }
    for (const [id, { proposalId }] of Object.entries(
      comments as Record<string, { proposalId: string }>,
    )) {
      expect(log.resolution(id)?.proposalId, id).toBe(proposalId);
    }
    expect(log.winner("unknown")).toBeUndefined();
    expect(log.resolution("a1")).toBeUndefined();
  });
});
