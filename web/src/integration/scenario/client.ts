// One client of the publication scenario: its pages, opened, reloaded,
// retired, and what they store.
import { LoroDoc, decodeImportBlobMeta } from "loro-crdt";
import type { Role } from "../../../lib/src/crypto/role-secrets.js";
import {
  type ConfirmedRecord,
  connectDocument,
} from "../../../lib/src/transport/client.js";
import { CloseCode } from "../../../lib/src/transport/protocol.js";
import type { ScheduledSocket } from "../../../lib/src/transport/test-support/scheduled-server.js";
import { roleSecretSync } from "../../../lib/src/transport/test-support/verifiers.js";
import {
  type LocalOwner,
  persistLocally,
  resumeFrom,
} from "../../app/local-persistence.js";
import type { LocalRecord } from "../../storage/index.js";
import {
  CHANNELS,
  type Client,
  type Settings,
  type World,
  decisionSeqs,
  plainDecrypt,
  tick,
} from "./world.js";

export function newClient(
  index: number,
  settings: Settings,
  role: Role,
): Client {
  const client: Client = {
    index,
    role,
    localOnly: new Set(),
    docs: { content: new LoroDoc(), annotations: new LoroDoc() },
    sockets: [],
    busy: 0,
    epoch: 0,
    confirmed: [],
    decided: 0,
    lost: new Set(),
    undelivered: new Set(),
    adopted: [],
    rotatedTo: [],
    settings,
    page: { dropWrites: false },
    saved: { content: new Map(), annotations: new Map() },
    peers: { content: new Set(), annotations: new Set() },
  };
  client.docs.content.setPeerId(BigInt(index + 1));
  client.docs.annotations.setPeerId(BigInt(index + 1));
  return client;
}

/** Opens `client` on the document with the current edit link: its first
 * opening, or the user opening the new link after a rotation — a new
 * page, with new docs (what the old one never got acked is lost with it,
 * as when a tab closes, ADR-0015). */
export function open(world: World, client: Client): void {
  const { server, problems } = world;
  const { index, settings } = client;
  const { reload, gate } = world.options;
  const epoch = ++client.epoch;
  const record = reload ? client.stored : undefined;
  if (epoch > 1) {
    client.docs = { content: new LoroDoc(), annotations: new LoroDoc() };
    // What it wrote without the right to publish comes back with the
    // record: still local.
    if (!reload) client.localOnly = new Set();
    const peer = BigInt(1_000_000 + epoch * 16 + index);
    client.docs.content.setPeerId(peer);
    client.docs.annotations.setPeerId(peer);
    client.adopted = [];
  }
  for (const stored of record?.channels ?? []) {
    client.docs[stored.channel].import(stored.snapshot);
    // Adopted and not acked: this page publishes them (R-A2).
    client.adopted.push(...stored.adopted.map(({ change }) => change));
  }
  for (const channel of CHANNELS) {
    client.peers[channel].add(client.docs[channel].peerIdStr);
  }
  const current = () => client.epoch === epoch;
  // A decision not yet acked is lost with its page, unless the record
  // carries it: this page sends it.
  const carried = new Set(
    (record?.decisions.outbox ?? []).map((bytes) => String([...bytes])),
  );
  for (const n of client.undelivered) {
    if (!carried.has(String([index, n]))) client.lost.add(n);
  }
  const undelivered = [...client.undelivered].filter((n) =>
    carried.has(String([index, n])),
  );
  client.rotatedTo = [];
  client.undelivered = new Set(undelivered);
  client.refused = undefined;
  client.connection = undefined;
  client.handle = undefined;
  const confirmed: ConfirmedRecord[] = [...(record?.decisions.confirmed ?? [])];
  client.confirmed = confirmed;
  const page = { dropWrites: false };
  client.page = page;
  client.persistence = undefined;
  // The page's store write, done when the test releases it (the gate): an
  // IndexedDB transaction completes on its own time.
  const apply = async (saved: LocalRecord) => {
    if (page.dropWrites) return; // never created before the page died
    client.stored = saved;
    noteSaved(client, saved);
  };
  const write = gate ? gate.wrap(`store c${index}`, apply) : apply;
  const openedWith = world.secrets.current();
  const refused = (code: number) => {
    if (!current()) return;
    // 4401 answers a replaced link, or a deleted document: never a
    // current one — the official client sends nothing before its `auth`
    // is answered (ADR-0019 §3).
    if (
      code === CloseCode.Unauthenticated &&
      openedWith === world.secrets.current() &&
      !server.deletedBy
    ) {
      problems.push(`client${index} was refused 4401 with the current link`);
    }
    if (code === CloseCode.Deleted && !server.deletedBy) {
      problems.push(
        `client${index} was told the document is deleted, it isn't`,
      );
    }
    if (
      client.rotatedTo.includes(world.secrets.current()) &&
      !server.deletedBy // a deleted document opens to no link
    ) {
      problems.push(
        `client${index} was refused (${code}) after its own rotation passed`,
      );
    }
    client.refused = code;
    client.connection = undefined;
    client.handle = undefined;
  };
  connectDocument({
    url: "scheduled://",
    documentId: "doc",
    key: world.key,
    credentials: {
      role: client.role,
      secret: roleSecretSync(world.secrets.current(), client.role),
    },
    channels: CHANNELS.map((channel) => ({
      channel,
      doc: client.docs[channel],
    })),
    socketFactory: () => {
      const socket = server.connect() as ScheduledSocket;
      client.sockets.push(socket);
      return socket;
    },
    compactionThreshold: settings.compactionThreshold,
    maxMessageBytes: settings.maxMessageBytes,
    publishIntervalMs: settings.publishIntervalMs,
    reconnectDelayMs: settings.reconnectDelayMs,
    onRefused: refused,
    onConnection: (connection) => {
      client.handle = connection;
      if (!reload) return;
      const owner: LocalOwner = {
        kind: "owner",
        record,
        save: write,
        release: () => {},
      };
      client.persistence = persistLocally({
        owner,
        docs: client.docs,
        connection,
        confirmed,
        delayMs: settings.saveDelayMs,
      });
    },
    ...(record && { resume: resumeFrom(record) }),
    onAcked: () => {
      if (current()) client.persistence?.changed();
    },
    onRenewed: (secret) => {
      if (client.rotatedTo.includes(secret)) client.rotatedTo = [];
    },
    decisions: settings.decisions
      ? {
          onConfirmed: (batch) => {
            if (!current()) return;
            client.confirmed.push(...batch);
            client.persistence?.changed();
            // Checked at every batch: the union of batches is a gapless
            // prefix of the journal (DecisionsConnection).
            const journal = decisionSeqs(server);
            const seqs = client.confirmed.map((record) => record.seq);
            const prefix = journal.slice(0, seqs.length);
            if (JSON.stringify(seqs) !== JSON.stringify(prefix)) {
              problems.push(
                `client${index} confirmed decisions ${JSON.stringify(seqs)}, the journal holds ${JSON.stringify(journal)}`,
              );
            }
          },
        }
      : undefined,
    ...(world.options.presence && {
      presence: {
        // Checked at each reception: what arrives is a state a page sent,
        // intact — never another channel's frame, never the page's own.
        receive: (bytes: Uint8Array) => {
          const state = new TextDecoder().decode(bytes);
          if (!world.presenceSent.has(state)) {
            problems.push(
              `client${index} received an unknown presence: ${state}`,
            );
          }
          // A page: a client at one of its openings (`epoch`).
          if (state.split(" ")[1]?.startsWith(`${index}.${epoch}.`)) {
            problems.push(`client${index}'s page received its own presence`);
          }
        },
        connected: () => {},
      },
    }),
    activity: {
      begin: () => client.busy++,
      end: () => client.busy--,
    },
  }).then(
    (connection) => {
      if (current() && client.refused === undefined) {
        client.connection = connection;
      }
    },
    (error: { code?: number }) => refused(error.code ?? 0),
  );
}

/** Phase 7 L1's bookkeeping: what a write put in the store, per peer. */
export function noteSaved(client: Client, record: LocalRecord): void {
  for (const stored of record.channels) {
    const doc = new LoroDoc();
    doc.import(stored.snapshot);
    const saved = client.saved[stored.channel];
    for (const [peer, counter] of doc.oplogVersion().toJSON()) {
      saved.set(peer, Math.max(saved.get(peer) ?? 0, counter));
    }
  }
}

/** The page of `client` goes away (reloaded, or replaced by the new link):
 * a store write it had not created a transaction for never happens
 * (`applyHeld` false), one it had does (R-L4: before the next page
 * reads). Its connection dies with it. */
export async function retire(
  world: World,
  client: Client,
  applyHeld: boolean,
): Promise<void> {
  const { gate } = world.options;
  const mine = () =>
    gate?.held.filter((held) =>
      held.label.startsWith(`store c${client.index} `),
    ) ?? [];
  if (applyHeld) {
    for (const held of mine()) gate?.release(held);
    await tick();
  }
  client.page.dropWrites = true;
  client.persistence?.close();
  for (const held of mine()) gate?.release(held);
  client.handle?.close();
}

/** Phase 7 L2 on the record the next page reads: every entry its cursor covers is
 * in its snapshot. Decrypted outside the gate (the test's own reading). */
export async function checkStored(world: World, client: Client): Promise<void> {
  const record = client.stored;
  if (!record) return;
  for (const stored of record.channels) {
    const doc = new LoroDoc();
    doc.import(stored.snapshot);
    const version = doc.oplogVersion();
    for (const entry of world.server.journal) {
      if (entry.channel !== stored.channel || entry.seq > stored.cursor)
        continue;
      const meta = decodeImportBlobMeta(
        await plainDecrypt(world.key, entry.blob),
        false,
      );
      if (meta.mode.includes("snapshot")) continue;
      for (const [peer, end] of meta.partialEndVersionVector.toJSON()) {
        if ((version.get(peer) ?? 0) < end) {
          world.problems.push(
            `client${client.index}'s record: ${stored.channel} cursor ${stored.cursor} covers entry ${entry.seq}, not in its snapshot`,
          );
          return;
        }
      }
    }
  }
}
