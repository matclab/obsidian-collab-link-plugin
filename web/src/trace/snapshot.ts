import type { EditorView } from "@codemirror/view";
import type { LoroDoc } from "loro-crdt";
import { listAnnotations } from "../../lib/src/index.js";
import type { Snapshot } from "./format.js";

export function takeSnapshot(
  contentDoc: LoroDoc,
  annotationsDoc: LoroDoc,
  view: EditorView,
  confirmed: number,
): Snapshot {
  return {
    text: contentDoc.getText("content").toString(),
    view: view.state.doc.toString(),
    annotations: listAnnotations(contentDoc, annotationsDoc)
      .map(({ id, type, status, range }) => ({ id, type, status, range }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    confirmed,
  };
}

/** The first field on which two snapshots differ, or `undefined`. */
export function snapshotDifference(
  expected: Snapshot,
  actual: Snapshot,
): string | undefined {
  for (const key of ["text", "view", "confirmed"] as const) {
    if (expected[key] !== actual[key]) {
      return `${key}: expected ${JSON.stringify(expected[key])}, got ${JSON.stringify(actual[key])}`;
    }
  }
  const e = JSON.stringify(expected.annotations);
  const a = JSON.stringify(actual.annotations);
  if (e !== a) return `annotations: expected ${e}, got ${a}`;
  return undefined;
}
