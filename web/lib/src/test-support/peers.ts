import { LoroDoc } from "loro-crdt";

let nextPeerId = 1n;

export function createPeer(): LoroDoc {
  const doc = new LoroDoc();
  doc.setPeerId(nextPeerId++);
  return doc;
}

export function syncOnce(from: LoroDoc, to: LoroDoc): void {
  const bytes = from.export({ mode: "update", from: to.oplogVersion() });
  if (bytes.length > 0) to.import(bytes);
}

export function syncAll(peers: readonly LoroDoc[]): void {
  for (const from of peers) {
    for (const to of peers) {
      if (from !== to) syncOnce(from, to);
    }
  }
}
