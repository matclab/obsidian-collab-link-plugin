/** The signatures of a document, verified once each
 * (docs/protocol/06-identity.md, §6.6), in the shape of `AnnotationIndex`:
 * `current()` says, for each signed object, whether it is signed and by
 * which key — never by a verification of other values than those it
 * holds now (SG1, SG6) —, and subscribers are told at most once per
 * microtask when that may have changed: the annotations doc changed, a
 * decision was confirmed, a presence arrived, a verification ended.
 *
 *Nothing here resolves an anchor, nor listens to the text: a keystroke
 * costs nothing (SG4). A message is rebuilt synchronously from the values
 * read; Ed25519 runs once per key, signature and message, its result kept
 * for the page's life.
 *
 *With attestation keys configured (§6.10), a signed object is also
 * **attested** when an attestation the document carries covers its date,
 * and the newest revocation list given doesn't revoke its key by then
 * (AT1, AT4). Each entry of `attestations` is read once. */
import type { LoroDoc } from "loro-crdt";
import type {
  ConfirmedProposal,
  DecisionLog,
} from "../annotations/decisions.js";
import { readAnnotationEntry } from "../annotations/model.js";
import {
  peerNames,
  peerSignature,
  readVersionEntries,
} from "../history/tables.js";
import { count, span } from "../perf/index.js";
import type { RemotePresence } from "../presence/presence.js";
import {
  ATTESTATIONS,
  type Attestation,
  type RevocationList,
  attests,
  newerList,
  readAttestationEntry,
  revocationOf,
} from "./attestation.js";
import { formatShortFingerprint, verifyBytes } from "./keys.js";
import {
  type SignedKind,
  annotationMessage,
  decisionMessage,
  peerMessage,
  presenceMessage,
  replyMessage,
  versionMessage,
} from "./messages.js";
import { type KnownKey, knownKey, readIdentities } from "./signature.js";

/** What a client shows of an object (ID-17, ID-18). */
export type Verdict =
  | { signed: false }
  | {
      signed: true;
      /** The signer's fingerprint (ID-5). */
      fingerprint: Uint8Array;
      /** Its short form, as shown (`3fa1 9c02 77de 01b4`). */
      short: string;
      /** The name it carries is signed by another key elsewhere in the
       * document (ID-17). */
      twoKeys: boolean;
      /** With `twoKeys`, every key the name is signed by in the
       * document, this one included, in the order of their fingerprints
       * (ID-42). */
      nameKeys?: readonly NameKey[];
      /** Received live more than 24 hours after its date (ID-18). */
      late?: { dated: number; received: number };
      /** The attestation naming it (ID-39): its name replaces the one the
       * object carries. */
      attested?: Attestation;
      /** When the newest revocation list revoked its key (ID-39), Unix
       * seconds; said even of an object dated before. */
      revokedAt?: number;
    };

/** A key a name is signed by (ID-42). */
export interface NameKey {
  /** Its fingerprint (ID-5), in lowercase hexadecimal. */
  fingerprint: string;
  /** Its short form, as shown. */
  short: string;
}

export interface SignatureView {
  /** A reply's id is `<annotation id>/<reply id>`. */
  of(kind: SignedKind, id: string): Verdict;
  /** Changes only when a verdict of one of `kinds` changed: what shows
   * annotations isn't drawn again for a name registered in `peers`. */
  version(...kinds: SignedKind[]): string;
  /** No verification nor reading of an attestation ran when this view was
   * made: an object that carries a signature and reads unsigned is then
   * not signed by a key known, not about to be (ADR-0050 §2). */
  readonly settled: boolean;
}

const KINDS: readonly SignedKind[] = [
  "annotation",
  "reply",
  "decision",
  "version",
  "peer",
  "presence",
];

/** What a verdict shows, as text: equal verdicts, equal text. */
function shown(verdict: Verdict): string {
  if (!verdict.signed) return "";
  const late = verdict.late
    ? `${verdict.late.dated}/${verdict.late.received}`
    : "";
  const keys = verdict.nameKeys?.map((key) => key.fingerprint).join(",");
  return `${verdict.short}|${verdict.twoKeys}|${late}|${verdict.attested?.id ?? ""}|${verdict.revokedAt ?? ""}|${keys ?? ""}`;
}

/** How long after its date an object received live is said late (ID-18). */
export const LATE_AFTER_MS = 24 * 3600 * 1000;

const UNSIGNED: Verdict = Object.freeze({ signed: false });

/** The key of a reply in `of`. */
export const replyKey = (annotationId: string, replyId: string) =>
  `${annotationId}/${replyId}`;

const HEX = Array.from({ length: 256 }, (_, b) =>
  b.toString(16).padStart(2, "0"),
);
const toHex = (bytes: Uint8Array) => {
  let text = "";
  for (const byte of bytes) text += HEX[byte];
  return text;
};

/** Bytes as a string, one character each: an exact key, cheaper than a
 * hash of them. */
const asKey = (bytes: Uint8Array) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 4096) {
    text += String.fromCharCode(...bytes.subarray(i, i + 4096));
  }
  return text;
};

/** A signed object as read: its signature, how to build its message for
 * a signer, the name it carries, its date. */
interface Job {
  kind: SignedKind;
  id: string;
  sig: unknown;
  build(signer: Uint8Array): Uint8Array | undefined;
  name: string;
  date?: number;
  /** A presence's own key (ID-11). */
  pk?: unknown;
  /** When a presence state was received, by the reader's clock (ID-39). */
  received?: number;
}

/** What a job may be signed by: each key of its short fingerprint, and
 * the name of the verification of its message by that key. */
interface Attempt {
  key: KnownKey;
  name: string;
  signature: Uint8Array;
  message: Uint8Array;
}

interface Read {
  job: Job;
  attempts: Attempt[];
}

/** Where presence comes from (`Presence`). */
export interface PresenceSource {
  others(): RemotePresence[];
  subscribe(listener: () => void): () => void;
}

export class SignatureIndex {
  private readonly results = new Map<string, boolean>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribes: (() => void)[];
  /** Each object seen, by kind, id and signature; and, once the history
   * is loaded, when it was first seen (ID-18). */
  private readonly seen = new Map<string, number | undefined>();
  private live = false;
  private scheduled = false;
  /** What was read of the document, by piece, each read again only when
   * its source changed (Loro tells which, synchronously, at each commit
   * and import): an annotation with its replies, by id; a confirmed
   * decision, never again (a winner doesn't change); the tables; the keys
   * — when they change, everything. */
  private known: KnownKey[] | undefined;
  private readonly byAnnotation = new Map<string, Read[]>();
  private dirtyAnnotations: Set<string> | "all" = "all";
  private readonly byProposal = new Map<string, Read>();
  private tables: Read[] | undefined;
  private documentReads: Read[] | undefined;
  private presencePart: Read[] | undefined;
  private view: SignatureView | undefined;
  /** Each entry of `attestations` read, by key and bytes, valid or `null`;
   * those being read;
   * the valid ones present now, by attested key (hexadecimal). */
  private readonly attestationResults = new Map<string, Attestation | null>();
  private readonly attestationRuns = new Map<string, Promise<void>>();
  private byKey: Map<string, Attestation[]> | undefined;
  private revocations: RevocationList | undefined;
  private attestationKeys: ReadonlySet<string> | undefined;
  /** Moves with the keys: a reading under the previous ones is dropped. */
  private keysGeneration = 0;

  constructor(
    private readonly options: {
      documentId: string;
      /** The annotations doc: what is signed is there, and `identities`.
       * The text isn't read: typing costs nothing (SG4). */
      annotationsDoc: LoroDoc;
      log: Pick<DecisionLog, "winner" | "resolution" | "subscribe" | "version">;
      /** The others' presence: given, only it is read — an index of the
       * document isn't told of every presence state (one every 200 ms per
       * page moving), what shows presence isn't told of the document. */
      presence?: PresenceSource;
      /** The reader's clock (ID-18). */
      now?: () => number;
      /** The fingerprints, in hexadecimal, of the attestation keys this
       * deployment configured (ID-26); none, nothing is attested. */
      attestationKeys?: ReadonlySet<string>;
    },
  ) {
    const { annotationsDoc, log, presence } = options;
    this.attestationKeys = options.attestationKeys;
    this.unsubscribes = presence
      ? [
          presence.subscribe(() => this.changed("presence")),
          annotationsDoc.subscribe((batch) => this.onDocument(batch)),
        ]
      : [
          annotationsDoc.subscribe((batch) => this.onDocument(batch)),
          log.subscribe(() => {
            this.documentReads = undefined;
            this.changed("document");
          }),
        ];
  }

  /** The history loaded at opening is read: what is seen from now on is
   * received live (ID-18). */
  opened(): void {
    this.current();
    this.live = true;
  }

  /** The same object while nothing it shows changed: what was read
   * (re-read only when its source changed), and the results known. */
  current(): SignatureView {
    return span("signatures.read", () => this.computed());
  }

  private computed(): SignatureView {
    const reads = [...this.readDocument(), ...this.readPresence()];
    if (this.view) return this.view;
    const verdicts = this.verdicts(reads);
    // A kind's version moves only if one of its verdicts changed.
    const digests = new Map<SignedKind, string[]>(KINDS.map((k) => [k, []]));
    for (const [key, verdict] of verdicts) {
      const kind = key.slice(0, key.indexOf("|")) as SignedKind;
      digests.get(kind)?.push(`${key}=${shown(verdict)}`);
    }
    for (const kind of KINDS) {
      const digest = (digests.get(kind) ?? []).sort().join("\n");
      if (this.digests.get(kind) !== digest) {
        this.digests.set(kind, digest);
        this.versions.set(kind, (this.versions.get(kind) ?? 0) + 1);
      }
    }
    const versions = new Map(this.versions);
    const settled = this.running.size === 0 && this.attestationRuns.size === 0;
    const view: SignatureView = {
      settled,
      of: (kind, id) => verdicts.get(`${kind}|${id}`) ?? UNSIGNED,
      version: (...kinds) =>
        kinds.map((kind) => versions.get(kind) ?? 0).join("."),
    };
    this.view = view;
    return view;
  }

  private readonly digests = new Map<SignedKind, string>();
  private readonly versions = new Map<SignedKind, number>();

  /** Resolves once no verification nor reading runs (tests, measures). */
  async idle(): Promise<void> {
    this.current();
    while (this.running.size > 0 || this.attestationRuns.size > 0) {
      await Promise.all([
        ...this.running.values(),
        ...this.attestationRuns.values(),
      ]);
      this.current();
    }
  }

  /** The attestation keys configured, once known (`/config.json` is read
   * beside the opening, never before it): what was read under others is
   * read again. */
  setAttestationKeys(keys: ReadonlySet<string>): void {
    this.attestationKeys = keys;
    this.keysGeneration += 1;
    this.attestationRuns.clear();
    this.attestationResults.clear();
    this.byKey = undefined;
    this.view = undefined;
    this.notify();
  }

  /** A revocation list read (ID-40): kept if newer than the one kept, an
   * older one ignored (AT4). */
  setRevocations(list: RevocationList | undefined): void {
    const kept = newerList(this.revocations, list);
    if (kept === this.revocations) return;
    this.revocations = kept;
    this.view = undefined;
    this.notify();
  }

  /** Told at most once per microtask when `current()` may have changed. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  destroy(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.listeners.clear();
  }

  /** Marks what a batch of the annotations doc changed. */
  private onDocument(batch: {
    events: readonly { path: readonly unknown[]; diff: unknown }[];
  }): void {
    for (const event of batch.events) {
      const [root, id] = event.path;
      if (root === ATTESTATIONS) {
        this.byKey = undefined;
        this.view = undefined;
        this.notify();
        continue;
      }
      // Presence alone: nothing else of the document is read.
      if (this.options.presence) continue;
      if (root === "annotations") {
        if (this.dirtyAnnotations === "all") continue;
        if (typeof id === "string") this.dirtyAnnotations.add(id);
        else {
          // The root map itself: entries added, replaced or removed.
          const updated = (event.diff as { updated?: object }).updated ?? {};
          for (const key of Object.keys(updated)) {
            this.dirtyAnnotations.add(key);
          }
        }
      } else if (root === "identities") {
        this.known = undefined;
        this.dirtyAnnotations = "all";
        this.byProposal.clear();
        this.tables = undefined;
      } else if (
        root === "versions" ||
        root === "peers" ||
        root === "peerSignatures"
      ) {
        this.tables = undefined;
      } else {
        continue; // nothing signed there: nothing to say
      }
      this.documentReads = undefined;
      this.changed("document");
    }
  }

  private changed(part: "document" | "presence"): void {
    if (part === "presence") this.presencePart = undefined;
    this.view = undefined;
    this.notify();
  }

  private notify(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      for (const listener of [...this.listeners]) listener();
    });
  }

  /** The document's signed objects: what changed read again, the rest
   * as it was. */
  private readDocument(): Read[] {
    const { annotationsDoc: doc, log } = this.options;
    if (this.options.presence) return [];
    if (this.documentReads) return this.documentReads;
    count("signatures.compute");
    this.known ??= readIdentities(doc);
    const known = this.known;
    const annotations = doc.getMap("annotations");
    const dirty =
      this.dirtyAnnotations === "all"
        ? annotations.keys()
        : [...this.dirtyAnnotations];
    if (this.dirtyAnnotations === "all") this.byAnnotation.clear();
    for (const id of dirty) {
      this.byAnnotation.set(
        id,
        this.annotationJobs(doc, id).map((job) => this.read(job, known)),
      );
    }
    this.dirtyAnnotations = new Set();
    const context = this.context();
    const proposals = [...annotations.keys()].flatMap((id) =>
      [log.winner(id), log.resolution(id)].filter((p) => p !== undefined),
    );
    // A proposal id on two records names neither (as a reply's, ID-10).
    const used = proposals.map((p) => p.proposalId);
    const decisions: Read[] = [];
    for (const proposal of proposals) {
      if (
        used.indexOf(proposal.proposalId) !==
        used.lastIndexOf(proposal.proposalId)
      ) {
        continue;
      }
      // Its record, whole: a winner never changes, but another record
      // may come under the same id.
      const name = `${proposal.proposalId}|${proposal.annotationId}|${proposal.seq}`;
      let read = this.byProposal.get(name);
      if (!read) {
        read = this.read(decisionJob(proposal, context), known);
        this.byProposal.set(name, read);
      }
      decisions.push(read);
    }
    this.tables ??= this.tableJobs(doc).map((job) => this.read(job, known));
    this.documentReads = [
      ...[...this.byAnnotation.values()].flat(),
      ...decisions,
      ...this.tables,
    ];
    this.view = undefined;
    return this.documentReads;
  }

  private readPresence(): Read[] {
    const { presence } = this.options;
    if (!presence) return [];
    if (this.presencePart) return this.presencePart;
    const context = this.context();
    this.presencePart = presence.others().map((other) =>
      this.read(
        {
          kind: "presence",
          id: other.key,
          sig: other.sig,
          pk: other.pk,
          name: other.name,
          received: (this.options.now ?? Date.now)(),
          build: (signer) =>
            presenceMessage(context(signer), other.key, {
              seq: other.seq,
              name: other.name,
              color: other.color,
            }),
        },
        [],
      ),
    );
    this.view = undefined;
    return this.presencePart;
  }

  private context() {
    const { documentId } = this.options;
    return (signer: Uint8Array) => ({ documentId, signer });
  }

  /** An annotation and its replies; none if it isn't one (D-8) or gone. */
  private annotationJobs(doc: LoroDoc, id: string): Job[] {
    const read = readAnnotationEntry(doc, id);
    if (!read) return [];
    const context = this.context();
    const { fields } = read;
    const jobs: Job[] = [
      {
        kind: "annotation",
        id,
        sig: read.sig,
        name: fields.author,
        date: fields.createdAt,
        build: (signer) => annotationMessage(context(signer), id, fields),
      },
    ];
    // ID-10: an id given to two replies names neither — a copy of a
    // signed reply's id (and sig) must not share its verdict.
    const ids = read.replies.map((reply) => reply.id);
    for (const reply of read.replies) {
      if (reply.id === undefined) continue;
      if (ids.indexOf(reply.id) !== ids.lastIndexOf(reply.id)) continue;
      const replyId = reply.id;
      jobs.push({
        kind: "reply",
        id: replyKey(id, replyId),
        sig: reply.sig,
        name: reply.author,
        date: reply.createdAt,
        build: (signer) =>
          replyMessage(context(signer), replyId, {
            annotation: id,
            author: reply.author,
            createdAt: reply.createdAt,
            body: reply.body,
          }),
      });
    }
    return jobs;
  }

  /** The named versions and the names in `peers`. */
  private tableJobs(doc: LoroDoc): Job[] {
    const context = this.context();
    const jobs: Job[] = [];
    for (const version of readVersionEntries(doc)) {
      jobs.push({
        kind: "version",
        id: version.id,
        sig: version.sig,
        name: version.author,
        date: version.at,
        build: (signer) => versionMessage(context(signer), version.id, version),
      });
    }
    for (const [peer, name] of peerNames(doc)) {
      jobs.push({
        kind: "peer",
        id: peer,
        sig: peerSignature(doc, peer),
        name,
        build: (signer) => peerMessage(context(signer), peer, name),
      });
    }
    return jobs;
  }

  /** The keys a job may be signed by, its message built for each. */
  private read(job: Job, known: readonly KnownKey[]): Read {
    const { sig } = job;
    if (!(sig instanceof Uint8Array) || sig.length !== 72) {
      return { job, attempts: [] };
    }
    const own = job.pk === undefined ? undefined : knownKey(job.pk);
    const keys = own ? [own] : job.pk === undefined ? known : [];
    const short = toHex(sig.slice(0, 8));
    const signature = sig.slice(8);
    const attempts: Attempt[] = [];
    for (const key of keys) {
      if (toHex(key.fingerprint.slice(0, 8)) !== short) continue;
      const message = job.build(key.fingerprint);
      if (!message) return { job, attempts: [] }; // ID-14
      attempts.push({
        key,
        signature,
        message,
        name: `${asKey(key.publicKey)}|${asKey(sig)}|${asKey(message)}`,
      });
    }
    return { job, attempts };
  }

  /** Each object's verdict, from the results known; starts what isn't. */
  private verdicts(reads: readonly Read[]): Map<string, Verdict> {
    const signedBy = new Map<string, { read: Read; key: KnownKey }>();
    const keysOfName = new Map<string, Map<string, Uint8Array>>();
    for (const read of reads) {
      const objectKey = `${read.job.kind}|${read.job.id}`;
      this.note(read);
      for (const attempt of read.attempts) {
        const result = this.results.get(attempt.name);
        if (result === undefined) this.start(attempt);
        if (result !== true) continue;
        signedBy.set(objectKey, { read, key: attempt.key });
        const keys = keysOfName.get(read.job.name) ?? new Map();
        keys.set(toHex(attempt.key.fingerprint), attempt.key.fingerprint);
        keysOfName.set(read.job.name, keys);
        break;
      }
    }
    // One list per name, shared by its verdicts.
    const nameKeys = new Map<string, readonly NameKey[]>();
    for (const [name, keys] of keysOfName) {
      if (keys.size < 2) continue;
      nameKeys.set(
        name,
        [...keys]
          .sort(([x], [y]) => (x < y ? -1 : 1))
          .map(([fingerprint, bytes]) => ({
            fingerprint,
            short: formatShortFingerprint(bytes),
          })),
      );
    }
    const verdicts = new Map<string, Verdict>();
    const byKey = this.attestationsByKey();
    for (const [objectKey, { read, key }] of signedBy) {
      const revokedAt = revocationOf(this.revocations, key.publicKey);
      const judged = read.job.date ?? read.job.received;
      const attested =
        read.job.kind === "decision" ||
        read.job.kind === "peer" ||
        judged === undefined
          ? undefined
          : (byKey.get(toHex(key.publicKey)) ?? []).find((a) =>
              attests(a, judged, revokedAt),
            );
      const received = this.seen.get(this.seenKey(read));
      const { date } = read.job;
      const late =
        received !== undefined &&
        date !== undefined &&
        received - date > LATE_AFTER_MS;
      verdicts.set(objectKey, {
        signed: true,
        fingerprint: key.fingerprint,
        short: formatShortFingerprint(key.fingerprint),
        twoKeys: nameKeys.has(read.job.name),
        ...(nameKeys.has(read.job.name) && {
          nameKeys: nameKeys.get(read.job.name),
        }),
        ...(late && { late: { dated: date, received } }),
        ...(attested && { attested }),
        ...(revokedAt !== undefined && { revokedAt }),
      });
    }
    return verdicts;
  }

  /** The valid attestations present, by attested key, the one to name an
   * object first (ID-39); starts reading what wasn't read. */
  private attestationsByKey(): Map<string, Attestation[]> {
    if (this.byKey) return this.byKey;
    const configured = this.attestationKeys;
    const byKey = new Map<string, Attestation[]>();
    if (!configured || configured.size === 0) return byKey;
    const map = this.options.annotationsDoc.getMap(ATTESTATIONS);
    for (const [entryKey, value] of map.entries()) {
      // By key and bytes: other bytes under a key are read anew (AT1).
      const name = `${entryKey}|${value instanceof Uint8Array ? asKey(value) : ""}`;
      const result = this.attestationResults.get(name);
      if (result === undefined) {
        this.readAttestation(name, entryKey, value, configured);
      } else if (result) {
        const key = toHex(result.key);
        byKey.set(key, [...(byKey.get(key) ?? []), result]);
      }
    }
    for (const list of byKey.values()) {
      list.sort((a, b) => b.issuedAt - a.issuedAt || (a.id < b.id ? -1 : 1));
    }
    this.byKey = byKey;
    return byKey;
  }

  private readAttestation(
    name: string,
    entryKey: string,
    value: unknown,
    configured: ReadonlySet<string>,
  ): void {
    if (this.attestationRuns.has(name)) return;
    count("identity.attestation");
    const generation = this.keysGeneration;
    const run = readAttestationEntry(entryKey, value, configured).then(
      (read) => {
        if (generation !== this.keysGeneration) return;
        this.attestationResults.set(name, read ?? null);
        this.attestationRuns.delete(name);
        this.byKey = undefined;
        this.view = undefined;
        if (this.attestationRuns.size === 0) this.notify();
      },
    );
    this.attestationRuns.set(name, run);
  }

  private seenKey(read: Read): string {
    const { kind, id, sig } = read.job;
    return `${kind}|${id}|${sig instanceof Uint8Array ? toHex(sig) : ""}`;
  }

  /** ID-18: when an object was first seen, once the history is loaded. */
  private note(read: Read): void {
    const key = this.seenKey(read);
    if (this.seen.has(key)) return;
    this.seen.set(
      key,
      this.live ? (this.options.now ?? Date.now)() : undefined,
    );
  }

  private start(attempt: Attempt): void {
    if (this.running.has(attempt.name)) return;
    count("identity.verify");
    const run = verifyBytes(
      attempt.key.publicKey,
      attempt.signature,
      attempt.message,
    ).then((ok) => {
      this.results.set(attempt.name, ok);
      this.running.delete(attempt.name);
      this.view = undefined;
      // Results end one task each (WebCrypto): told once the verifications
      // started together have all ended, not once per signature — at
      // opening, one rendering for all of them, not one each.
      if (this.running.size === 0) this.notify();
    });
    this.running.set(attempt.name, run);
  }
}

function decisionJob(
  proposal: ConfirmedProposal,
  context: (signer: Uint8Array) => { documentId: string; signer: Uint8Array },
): Job {
  return {
    kind: "decision",
    id: proposal.proposalId,
    sig: proposal.sig,
    name: proposal.author,
    build: (signer) =>
      decisionMessage(context(signer), proposal.proposalId, {
        annotation: proposal.annotationId,
        decision: proposal.decision,
        author: proposal.author,
        ...(proposal.change && { change: proposal.change }),
      }),
  };
}
