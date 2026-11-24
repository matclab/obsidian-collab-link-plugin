import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { createPeer, syncAll } from "../test-support/peers.js";
import {
  type AnnotationStatus,
  createAnnotation,
  listAnnotations,
  updateStatus,
} from "./model.js";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz ";
const STATUSES: readonly AnnotationStatus[] = [
  "open",
  "accepted",
  "rejected",
  "resolved",
];

function annotationKey(a: {
  id: string;
  type: string;
  author: string;
  status: string;
  range: { start: number; end: number } | null;
}) {
  return `${a.id}|${a.type}|${a.author}|${a.status}|${JSON.stringify(a.range)}`;
}

describe("annotations convergence under concurrent creation (property)", () => {
  test("two peers each creating a concurrent annotation converge to the same set, no loss or id collision", () =>
    hegel.testAsync(async (tc) => {
      const base = tc.draw(
        gs.text({ minSize: 2, maxSize: 30, alphabet: ALPHABET }),
      );

      const contentA = createPeer();
      contentA.getText("content").insert(0, base);
      contentA.commit();
      const contentB = createPeer();
      syncAll([contentA, contentB]);

      const annotationsA = createPeer();
      const annotationsB = createPeer();

      const len = base.length;
      const startA = tc.draw(gs.integers({ minValue: 0, maxValue: len }));
      const endA = tc.draw(gs.integers({ minValue: startA, maxValue: len }));
      const startB = tc.draw(gs.integers({ minValue: 0, maxValue: len }));
      const endB = tc.draw(gs.integers({ minValue: startB, maxValue: len }));

      const idA = createAnnotation(contentA, annotationsA, {
        type: "comment",
        start: startA,
        end: endA,
        author: "alice",
        body: "a",
      });
      const idB = createAnnotation(contentB, annotationsB, {
        type: "comment",
        start: startB,
        end: endB,
        author: "bob",
        body: "b",
      });

      syncAll([annotationsA, annotationsB]);

      const listA = listAnnotations(contentA, annotationsA);
      const listB = listAnnotations(contentB, annotationsB);

      const idsA = new Set(listA.map((a) => a.id));
      const idsB = new Set(listB.map((a) => a.id));

      if (idA === idB) {
        throw new Error(
          "id collision between two independently created annotations",
        );
      }
      if (idsA.size !== 2 || idsB.size !== 2) {
        throw new Error(
          `expected both peers to see 2 annotations, got A=${idsA.size} B=${idsB.size}`,
        );
      }
      if (
        !idsA.has(idA) ||
        !idsA.has(idB) ||
        !idsB.has(idA) ||
        !idsB.has(idB)
      ) {
        throw new Error("an annotation was lost on one of the peers");
      }

      const keysA = new Set(listA.map(annotationKey));
      const keysB = new Set(listB.map(annotationKey));
      if (keysA.size !== keysB.size || [...keysA].some((k) => !keysB.has(k))) {
        throw new Error(
          `peers diverged: A=${JSON.stringify([...keysA])} B=${JSON.stringify([...keysB])}`,
        );
      }
    }));

  test("two peers setting different statuses on the same annotation converge to the same status", () =>
    hegel.testAsync(async (tc) => {
      const base = tc.draw(
        gs.text({ minSize: 2, maxSize: 30, alphabet: ALPHABET }),
      );

      const contentA = createPeer();
      contentA.getText("content").insert(0, base);
      contentA.commit();
      const contentB = createPeer();
      syncAll([contentA, contentB]);

      const annotationsA = createPeer();
      const id = createAnnotation(contentA, annotationsA, {
        type: "addition",
        start: 0,
        end: base.length,
        author: "alice",
      });
      const annotationsB = createPeer();
      syncAll([annotationsA, annotationsB]);

      const statusA = tc.draw(gs.sampledFrom(STATUSES));
      const statusB = tc.draw(gs.sampledFrom(STATUSES));
      updateStatus(annotationsA, id, statusA);
      updateStatus(annotationsB, id, statusB);

      syncAll([annotationsA, annotationsB]);

      const finalA = listAnnotations(contentA, annotationsA).find(
        (a) => a.id === id,
      );
      const finalB = listAnnotations(contentB, annotationsB).find(
        (a) => a.id === id,
      );
      if (!finalA || !finalB) throw new Error("annotation disappeared");
      if (finalA.status !== finalB.status) {
        throw new Error(
          `peers diverged on status: A=${finalA.status} B=${finalB.status} (wrote A=${statusA} B=${statusB})`,
        );
      }
    }));
});
