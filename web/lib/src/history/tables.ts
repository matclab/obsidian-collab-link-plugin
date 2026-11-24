import { type LoroDoc, LoroMap, type OpId, type PeerID } from "loro-crdt";
import type { Seal } from "../annotations/model.js";
import { addAttestation } from "../identity/attestation.js";
import { addIdentity } from "../identity/signature.js";

/** The history's two tables, in the annotations doc: who wrote with which Loro
 * peer, and the versions of the text
 * someone named. Written by editors and reviewers — anyone who holds the
 * key and may publish on `annotations`: everything is checked on reading,
 * and a pseudonym is never verified (ADR-0008). Pure: no network. */

const PEERS = "peers";
const VERSIONS = "versions";
/** The signatures of the names in `peers`, under the same keys (ID-9). */
const PEER_SIGNATURES = "peerSignatures";

/** The root map of the named versions (D-20). */
export const VERSIONS_ROOT = VERSIONS;
/** The root maps of the tables: changes there resolve no annotation. */
export const HISTORY_ROOTS: readonly string[] = [
  PEERS,
  VERSIONS,
  PEER_SIGNATURES,
];

const MAX_NAME = 200;
const MAX_PEER = 2n ** 64n - 1n;
/** A Loro peer id: a decimal integer that fits in 64 bits (Loro throws on
 * a larger one). */
const isPeer = (value: string) =>
  /^\d{1,20}$/.test(value) && BigInt(value) <= MAX_PEER;

/** Records that `peers` write as `name`, unless they already do, with the
 * signature of each, if `seals` has one (ID-9, ID-12): writes (and
 * commits, once) only what changed. */
export function registerPeers(
  annotationsDoc: LoroDoc,
  peers: readonly string[],
  name: string,
  seals?: ReadonlyMap<string, Seal>,
): void {
  const table = annotationsDoc.getMap(PEERS);
  const signatures = annotationsDoc.getMap(PEER_SIGNATURES);
  let changed = false;
  for (const peer of peers) {
    const seal = seals?.get(peer);
    if (table.get(peer) !== name) {
      table.set(peer, name);
      changed = true;
    }
    if (seal && !sameBytes(signatures.get(peer), seal.sig)) {
      addIdentity(annotationsDoc, seal.signer);
      signatures.set(peer, seal.sig);
      changed = true;
    }
  }
  if (changed) annotationsDoc.commit();
}

const sameBytes = (held: unknown, bytes: Uint8Array) =>
  held instanceof Uint8Array &&
  held.length === bytes.length &&
  held.every((byte, i) => byte === bytes[i]);

/** The signature of a name in `peers` (ID-9), unchecked. */
export function peerSignature(
  annotationsDoc: LoroDoc,
  peer: string,
): Uint8Array | undefined {
  const sig = annotationsDoc.getMap(PEER_SIGNATURES).get(peer);
  return sig instanceof Uint8Array ? sig : undefined;
}

/** Loro peer → pseudonym, well-formed entries only. */
export function peerNames(annotationsDoc: LoroDoc): Map<string, string> {
  const names = new Map<string, string>();
  for (const [peer, name] of annotationsDoc.getMap(PEERS).entries()) {
    if (isPeer(peer) && typeof name === "string" && name.length <= MAX_NAME) {
      names.set(peer, name);
    }
  }
  return names;
}

export interface NamedVersion {
  id: string;
  name: string;
  author: string;
  /** When it was named, ms since the epoch (the namer's clock). */
  at: number;
  /** The content doc's frontiers when it was named. */
  frontiers: OpId[];
  /** This client holds that version of the text (the channels arrive
   * independently: a name may come before the text it names). */
  available: boolean;
}

/** A named version computed and not yet written (ID-12). */
export interface VersionDraft {
  id: string;
  fields: {
    name: string;
    author: string;
    at: number;
    frontiers: { peer: string; counter: number }[];
  };
}

/** Drafts the name of the version of the text at `frontiers` (the content
 * doc's). Throws on an empty name (after trimming) or one over 200
 * characters. */
export function draftVersion(
  frontiers: readonly OpId[],
  input: { name: string; author: string; at: number },
): VersionDraft {
  const name = input.name.trim();
  if (name.length === 0 || name.length > MAX_NAME) {
    throw new Error(`a version name has 1 to ${MAX_NAME} characters`);
  }
  return {
    id: crypto.randomUUID(),
    fields: {
      name,
      author: input.author,
      at: input.at,
      frontiers: frontiers.map(({ peer, counter }) => ({ peer, counter })),
    },
  };
}

/** Writes a drafted version, with its seal if signed, in one commit. */
export function writeVersion(
  annotationsDoc: LoroDoc,
  draft: VersionDraft,
  seal?: Seal,
): string {
  const entry = annotationsDoc
    .getMap(VERSIONS)
    .setContainer(draft.id, new LoroMap());
  entry.set("name", draft.fields.name);
  entry.set("author", draft.fields.author);
  entry.set("at", draft.fields.at);
  entry.set("frontiers", draft.fields.frontiers);
  if (seal) {
    addIdentity(annotationsDoc, seal.signer);
    if (seal.attestation) addAttestation(annotationsDoc, seal.attestation);
    entry.set("sig", seal.sig);
  }
  annotationsDoc.commit();
  return draft.id;
}

/** Names the version of the text at `frontiers`, unsigned. */
export function nameVersion(
  annotationsDoc: LoroDoc,
  frontiers: readonly OpId[],
  input: { name: string; author: string; at: number },
): string {
  return writeVersion(annotationsDoc, draftVersion(frontiers, input));
}

export function deleteVersion(annotationsDoc: LoroDoc, id: string): void {
  annotationsDoc.getMap(VERSIONS).delete(id);
  annotationsDoc.commit();
}

/** A named version as written (D-20), well formed, with its signature
 * unchecked (ID-9). */
export interface VersionEntry {
  id: string;
  name: string;
  author: string;
  at: number;
  frontiers: OpId[];
  sig?: Uint8Array;
}

/** The well-formed entries of `versions`, as written: what a signature
 * covers (ID-13), without asking the text anything. */
export function readVersionEntries(annotationsDoc: LoroDoc): VersionEntry[] {
  const entries: VersionEntry[] = [];
  for (const [id, entry] of annotationsDoc.getMap(VERSIONS).entries()) {
    if (!(entry instanceof LoroMap)) continue;
    const name = entry.get("name");
    const author = entry.get("author");
    const at = entry.get("at");
    const frontiers = toFrontiers(entry.get("frontiers"));
    const sig = entry.get("sig");
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      name.length > MAX_NAME ||
      typeof author !== "string" ||
      author.length > MAX_NAME ||
      typeof at !== "number" ||
      !Number.isFinite(at) ||
      !frontiers
    ) {
      continue;
    }
    entries.push({
      id,
      name,
      author,
      at,
      frontiers,
      ...(sig instanceof Uint8Array && { sig }),
    });
  }
  return entries;
}

/** The named versions, well-formed ones only, by date then id. */
export function listVersions(
  annotationsDoc: LoroDoc,
  contentDoc: LoroDoc,
): NamedVersion[] {
  const held = contentDoc.oplogVersion();
  return readVersionEntries(annotationsDoc)
    .map(({ sig: _sig, ...entry }) => ({
      ...entry,
      available: entry.frontiers.every(
        ({ peer, counter }) => (held.get(peer) ?? 0) > counter,
      ),
    }))
    .sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : 1));
}

function toFrontiers(value: unknown): OpId[] | undefined {
  if (!Array.isArray(value) || value.length > 1000) return undefined;
  const frontiers: OpId[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return undefined;
    const { peer, counter } = item as Record<string, unknown>;
    if (
      typeof peer !== "string" ||
      !isPeer(peer) ||
      !Number.isSafeInteger(counter) ||
      (counter as number) < 0
    ) {
      return undefined;
    }
    frontiers.push({ peer: peer as PeerID, counter: counter as number });
  }
  return frontiers;
}
