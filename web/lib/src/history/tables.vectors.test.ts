// The history's tables against the specification's vectors (D-19, D-20,
// docs/protocol/vectors.json): what a client keeps of `peers` and
// `versions` written by anyone who may publish on `annotations`.
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { fromHex, vectors } from "../test-support/vectors.js";
import { listVersions, peerNames } from "./tables.js";

const { document } = vectors;
const tables = document.history_tables;

function imported(hex: string): LoroDoc {
  const doc = new LoroDoc();
  doc.import(fromHex(hex));
  return doc;
}

describe("the history's tables, as the vectors say", () => {
  test("D-19: peers, well-formed entries only", () => {
    expect(Object.fromEntries(peerNames(imported(tables.snapshot)))).toEqual(
      tables.peers,
    );
  });

  test("D-20: versions, well-formed entries only, available when held", () => {
    const listed = listVersions(
      imported(tables.snapshot),
      imported(document.content_snapshot),
    );
    expect([...listed].sort((x, y) => (x.id < y.id ? -1 : 1))).toEqual(
      tables.versions,
    );
  });
});
