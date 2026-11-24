import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { watchConflicts } from "./conflicts.js";
import { createAnnotation, listAnnotations, updateStatus } from "./model.js";
import { findCrossingConflicts } from "./overlap.js";

describe("watchConflicts", () => {
  test("reports a new crossing pair after annotations from two peers are imported (case 2, ADR-0012)", () => {
    const contentA = new LoroDoc();
    contentA.setPeerId(1n);
    contentA.getText("content").insert(0, "0123456789012345");
    contentA.commit();
    const contentB = new LoroDoc();
    contentB.setPeerId(2n);
    contentB.import(contentA.export({ mode: "update" }));

    const annotationsA = new LoroDoc();
    annotationsA.setPeerId(1n);
    const annotationsB = new LoroDoc();
    annotationsB.setPeerId(2n);

    // Individually valid at creation time (neither peer can see the other's
    // annotation yet) — only crossing once merged.
    createAnnotation(contentA, annotationsA, {
      type: "comment",
      start: 0,
      end: 10,
      author: "alice",
      body: "a",
    });
    createAnnotation(contentB, annotationsB, {
      type: "comment",
      start: 5,
      end: 15,
      author: "bob",
      body: "b",
    });

    const reports: unknown[] = [];
    watchConflicts(contentA, annotationsA, (conflicts) => {
      reports.push(conflicts);
    });

    annotationsA.import(annotationsB.export({ mode: "update" }));

    expect(reports.length).toBeGreaterThan(0);
    expect(reports[reports.length - 1]).toHaveLength(1);
  });

  // `content` and `annotations` are two independently-syncing channels
  // (ADR-0012, case 3) — a peer can receive both annotations (already
  // crossing, from their author's point of view) before it has received
  // the `content` operations their anchors depend on. Until then,
  // resolveRange returns null (anchor.ts) and the pair is invisible to
  // findCrossingConflicts. A later *content-only* import, with no
  // annotation itself created or modified, is what completes the picture
  // and must trigger the recompute (ADR-0012 case 3's actual mechanism —
  // not an annotation created/changed, and not an annotations-channel
  // import either).
  test("a content-only import reveals a crossing pair that was already recorded but not yet resolvable", () => {
    const contentA = new LoroDoc();
    contentA.setPeerId(1n);
    contentA.getText("content").insert(0, "0123456789ABCDEF");
    contentA.commit();

    const annotationsA = new LoroDoc();
    annotationsA.setPeerId(1n);
    createAnnotation(contentA, annotationsA, {
      type: "comment",
      start: 0,
      end: 10,
      author: "alice",
      body: "a",
    });
    createAnnotation(contentA, annotationsA, {
      type: "comment",
      start: 5,
      end: 15,
      author: "alice",
      body: "b",
    });

    // A third peer receives the annotations first, but not yet the content
    // they're anchored on.
    const contentC = new LoroDoc();
    contentC.setPeerId(3n);
    const annotationsC = new LoroDoc();
    annotationsC.setPeerId(3n);
    annotationsC.import(annotationsA.export({ mode: "update" }));

    const reports: unknown[][] = [];
    watchConflicts(contentC, annotationsC, (conflicts) => {
      reports.push(conflicts);
    });

    expect(
      findCrossingConflicts(listAnnotations(contentC, annotationsC)),
    ).toHaveLength(0);

    contentC.import(contentA.export({ mode: "update" }));

    expect(reports.length).toBeGreaterThan(0);
    expect(reports[reports.length - 1]).toHaveLength(1);
  });

  // ADR-0012's conflict set is scoped to "annotations actives" — once one
  // side of a crossing pair is closed (accepted/rejected/resolved), its
  // effect on content (if any) is already applied and it no longer needs
  // resolving; a stale range crossing a closed annotation isn't a live
  // conflict.
  test("watchConflicts excludes a closed annotation (status no longer open) even if its range still crosses", () => {
    const contentA = new LoroDoc();
    contentA.setPeerId(1n);
    contentA.getText("content").insert(0, "0123456789ABCDEF");
    contentA.commit();
    const annotationsA = new LoroDoc();
    annotationsA.setPeerId(1n);
    const idA = createAnnotation(contentA, annotationsA, {
      type: "comment",
      start: 0,
      end: 10,
      author: "alice",
      body: "a",
    });
    createAnnotation(contentA, annotationsA, {
      type: "comment",
      start: 5,
      end: 15,
      author: "alice",
      body: "b",
    });
    updateStatus(annotationsA, idA, "resolved");

    const reports: unknown[][] = [];
    watchConflicts(contentA, annotationsA, (conflicts) => {
      reports.push(conflicts);
    });

    // Trigger a recompute via a (content) import, watchConflicts's actual
    // trigger mechanism — not by calling findCrossingConflicts directly.
    const remote = new LoroDoc();
    remote.setPeerId(2n);
    remote.import(contentA.export({ mode: "update" }));
    remote.getText("content").insert(16, "!");
    remote.commit();
    contentA.import(remote.export({ mode: "update" }));

    expect(reports.length).toBeGreaterThan(0);
    expect(reports[reports.length - 1]).toHaveLength(0);
  });
});
