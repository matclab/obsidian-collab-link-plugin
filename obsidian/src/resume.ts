import { type Frontiers, LORO_VERSION, type LoroDoc } from "loro-crdt";
import { formatVersion } from "./note-header.js";

const MAX_PEER = 2n ** 64n - 1n;

/** The peer a change from outside is resumed under: drawn from the document,
 * the base and the text, so that the same change resumed twice — on this
 * device, or on another after a `git pull` — gives the same operations under
 * the same ids, which Loro imports once (ME4). Loro's version is in it: another
 * diff would make other operations, which must not share these ids. */
export async function resumePeer(
  documentId: string,
  base: Frontiers,
  text: string,
): Promise<bigint> {
  const what = JSON.stringify([
    "resume-1",
    LORO_VERSION(),
    documentId,
    formatVersion(base),
    text,
  ]);
  const digest = new DataView(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(what)),
  );
  const peer = digest.getBigUint64(0);
  return peer === MAX_PEER ? MAX_PEER - 1n : peer;
}

/** "Resume this change": `text` replayed on the document as it was at `base`,
 * never on its current state (ME3): what it received since is merged by Loro,
 * not undone. The document is left as it is; the caller imports the change, and
 * publishes it. */
export function resumeChange(
  doc: LoroDoc,
  base: Frontiers,
  text: string,
  peer: bigint,
): Uint8Array {
  const fork = doc.forkAt(base);
  fork.setPeerId(peer);
  const from = fork.oplogVersion();
  fork.getText("content").update(text);
  fork.commit();
  return fork.export({ mode: "update", from });
}
