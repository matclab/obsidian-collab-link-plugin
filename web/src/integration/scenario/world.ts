// The world of the publication scenario (`run.ts`): the clients, the
// server, the options, and what every step settles on.
import type { TestCase } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { type LoroDoc, decodeImportBlobMeta } from "loro-crdt";
import { vi } from "vitest";
import { decrypt } from "../../../lib/src/crypto/aead.js";
import type { Role } from "../../../lib/src/crypto/role-secrets.js";
import type {
  ConfirmedRecord,
  DocumentConnection,
} from "../../../lib/src/transport/client.js";
import type { CryptoGate } from "../../../lib/src/transport/test-support/crypto-gate.js";
import type {
  ScheduledServer,
  ScheduledSocket,
} from "../../../lib/src/transport/test-support/scheduled-server.js";
import { verifiersSync } from "../../../lib/src/transport/test-support/verifiers.js";
import type { persistLocally } from "../../app/local-persistence.js";
import type { LocalRecord } from "../../storage/index.js";
import { moves, step } from "./moves.js";

export const CHANNELS = ["content", "annotations"] as const;

export type Channel = (typeof CHANNELS)[number];

export interface Client {
  index: number;
  /** The role of its link: it only does what its page lets it (a
   * read-only editor, the panel's actions, ADR-0019 §1). */
  role: Role;
  /** Channels it wrote on without the right to publish there: its text
   * differs there, legitimately. */
  localOnly: Set<Channel>;
  docs: Record<Channel, LoroDoc>;
  sockets: ScheduledSocket[];
  /** Work of its own in progress (timers, encryption): see `settle`. */
  busy: number;
  connection?: DocumentConnection;
  /** Bumped at each (re)opening: callbacks of an older connection are
   * ignored. */
  epoch: number;
  /** The server closed its connection for good (a rotation): the user
   * opens the new link, `reopen`. */
  refused?: number;
  /** Every decisions record confirmed to its current connection, in
   * delivery order. */
  confirmed: ConfirmedRecord[];
  decided: number;
  /** Decisions made on a connection that was refused since: lost with it,
   * like anything not yet acked on a revoked link. */
  lost: Set<number>;
  /** Decisions made on the current connection. */
  undelivered: Set<number>;
  /** The edit secrets of the rotations it sent, until it comes back with
   * one: the client must never be cut by its own rotation that passed,
   * even after sending another (R-B4). */
  rotatedTo: Uint8Array[];
  /** Detached changes its current page imported and adopted (ADR-0018):
   * lost with the page if not yet acked, like its own operations — other
   * editors adopt them again (`importAcceptedChanges`), which the
   * transport doesn't model. */
  adopted: Uint8Array[];
  /** Its connection from the moment it exists (`onConnection`). */
  handle?: DocumentConnection;
  settings: Settings;
  /** With `reload`: its page's local persistence, and the record the last
   * applied write left in its store (ADR-0022). */
  persistence?: ReturnType<typeof persistLocally>;
  page: { dropWrites: boolean };
  stored?: LocalRecord;
  /** Per channel, the most of each peer's operations a write ever put in
   * the store: all of it must reach the journal (phase 7, L1). */
  saved: Record<Channel, Map<string, number>>;
  /** Per channel, the Loro peer of each of its pages so far. */
  peers: Record<Channel, Set<string>>;
}

export interface Options {
  compaction: boolean;
  maxSteps: number;
  gate?: CryptoGate;
  /** Timers fire only when a step lets time pass. */
  clock?: boolean;
  decisions?: boolean;
  /** Editors renew the links (ADR-0019 §5), revoked clients reopen. */
  rotation?: boolean;
  /** Each client's role is drawn (ADR-0019 §1); otherwise all edit. */
  roles?: boolean;
  /** Editors adopt detached changes (docs/phase-5-modele-acces.md,
   * analysis A) and type after them. */
  adoption?: boolean;
  /** Pages keep a local record and reload from it (ADR-0022); a user who
   * opens the new link after a rotation reloads too. Needs `gate`: each
   * write to the store completes when Hegel says. */
  reload?: boolean;
  /** Editors set the document's expiry, and in one case out of two may
   * delete it (ADR-0023). */
  lifecycle?: boolean;
  /** Pages send presence states (ADR-0025): relayed, never journaled. */
  presence?: boolean;
  /** In one case out of two, the server reads at most 300 bytes per
   * message, and writes are sometimes 200 characters long: a client's own
   * operations must leave in several frames (docs/protocol/04-obligations.md,
   * O-18). Without decisions nor presence, whose records don't fit. */
  smallMessages?: boolean;
  /** The server sends what a later extension would
   * (docs/phase-8-protocole-ouvert.md, N4): messages under keys the client
   * doesn't know — one shaped like an ack — and frames of an unknown
   * channel, anywhere in either queue after the authentication reply. */
  unknown?: boolean;
}

/** The document's edit secrets, by the verifier the server holds. */
export class Secrets {
  private byVerifier = new Map<string, Uint8Array>();
  private drawn = 0;

  constructor(private readonly server: ScheduledServer) {}

  draw(): Uint8Array {
    const secret = new Uint8Array(32).fill(++this.drawn);
    this.byVerifier.set(verifiersSync(secret).edit, secret);
    return secret;
  }

  /** The edit secret of the current link. */
  current(): Uint8Array {
    const verifier = this.server.verifiers?.edit;
    const secret = verifier && this.byVerifier.get(verifier);
    if (!secret) throw new Error("no current edit secret");
    return secret;
  }
}

// Not `setTimeout`: faked when `clock` is on.
export const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Timers set and not yet fired, when the test drives the clock. */
export function timersPending(options: Options): number {
  return options.clock ? vi.getTimerCount() : 0;
}

/** Lets the clients react (timers, encryption, decryption) until none is
 * at work and nothing moves: what can be delivered next must not depend
 * on timing, or Hegel can neither replay nor shrink a failure. Waiting a
 * fixed number of turns was not enough on a busy machine (an encryption
 * outlasted it: flaky failures, "data generation is non-deterministic"). */
export async function settle(
  server: ScheduledServer,
  clients: Client[],
  options: Options,
): Promise<void> {
  const { gate } = options;
  const state = () =>
    JSON.stringify([
      gate?.held.map((held) => held.label),
      timersPending(options),
      server.journal.length,
      server.sockets.map((s) => [s.dead, s.replies.length, s.pushes.length]),
      clients.map((client) => [
        client.refused,
        client.connection === undefined,
      ]),
      clients.map((client) =>
        CHANNELS.map((channel) => client.docs[channel].frontiers()),
      ),
    ]);
  // With the gate, nothing is at work once no encryption or decryption
  // is running outside it: held work and timers not yet due wait for the
  // test, like a queued delivery; everything else runs in microtasks.
  const idle = gate
    ? () => gate.running === 0
    : () =>
        clients.reduce((sum, client) => sum + client.busy, 0) ===
        timersPending(options);
  let stable = 0;
  for (let turn = 0, before = state(); stable < 2; turn++) {
    if (turn > 100_000) throw new Error("the clients never settle");
    await tick();
    const now = state();
    stable = now === before && idle() ? stable + 1 : 0;
    before = now;
  }
}

export function text(doc: LoroDoc): string {
  return doc.getText("t").toString();
}

export interface Settings {
  compactionThreshold: number;
  publishIntervalMs: number;
  reconnectDelayMs: number;
  saveDelayMs: number;
  decisions: boolean;
  /** The server's message limit, which the client knows. */
  maxMessageBytes: number;
}

export async function plainDecrypt(
  key: CryptoKey,
  blob: Uint8Array,
): Promise<Uint8Array> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: blob.slice(0, 12) },
    key,
    blob.slice(12),
  );
  return new Uint8Array(plain);
}

export function decisionSeqs(server: ScheduledServer): number[] {
  return server.journal
    .filter((entry) => entry.channel === "decisions")
    .map((entry) => entry.seq);
}

/** Picks one of `options` — a Hegel draw in the test (always a draw, of
 * the same kind, whatever the options), a seeded generator to debug. */
export type Choose = <T>(options: readonly T[]) => T;

export function hegelChoose(tc: TestCase): Choose {
  return (options) => {
    const index = tc.draw(
      gs.integers({ minValue: 0, maxValue: options.length - 1 }),
    );
    const option = options[index];
    if (option === undefined) throw new Error("nothing to choose from");
    return option;
  };
}

export interface World {
  options: Options;
  server: ScheduledServer;
  key: CryptoKey;
  secrets: Secrets;
  problems: string[];
  /** Every detached change made so far. */
  changes: { peer: string; bytes: Uint8Array }[];
  /** This case lets an editor delete the document. */
  mayDelete: boolean;
  /** `setExpiry` calls neither resolved nor rejected yet. */
  pendingExpiries: number;
  /** Every presence state sent, as sent. */
  presenceSent: Set<string>;
}

export async function authorsOf(key: CryptoKey, blob: Uint8Array) {
  const plaintext = await decrypt(key, blob);
  const meta = decodeImportBlobMeta(plaintext, false);
  if (meta.mode.includes("snapshot")) return undefined;
  const start = meta.partialStartVersionVector.toJSON();
  return [...meta.partialEndVersionVector.toJSON()]
    .filter(([peer, end]) => end > (start.get(peer) ?? 0))
    .map(([peer]) => peer);
}
