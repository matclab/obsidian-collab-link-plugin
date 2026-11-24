// The scenario of `publication.property.test.ts`: several clients on two
// Loro channels against a ScheduledServer, every choice made by `choose`
// (a Hegel draw there; a seeded generator to replay one by hand). Options
// hand more to `choose` (`publication-async-order.property.test.ts`):
// when each encryption and decryption completes (`gate`), when each timer
// fires (`clock`), the decisions channel (`decisions`), and reloading a
// page from what it stored (`reload`, ADR-0022).
import { LoroDoc } from "loro-crdt";
import { vi } from "vitest";
import { decrypt, generateKey } from "../../../lib/src/crypto/aead.js";
import type { Role } from "../../../lib/src/crypto/role-secrets.js";
import { importHistory } from "../../../lib/src/transport/import-history.js";
import {
  CloseCode,
  MAX_MESSAGE_BYTES,
  mayPublish,
} from "../../../lib/src/transport/protocol.js";
import { ScheduledServer } from "../../../lib/src/transport/test-support/scheduled-server.js";
import { verifiersSync } from "../../../lib/src/transport/test-support/verifiers.js";
import { newClient, open, retire } from "./client.js";
import { type Move, moves, step } from "./moves.js";
import {
  CHANNELS,
  type Choose,
  type Client,
  type Options,
  Secrets,
  type World,
  authorsOf,
  decisionSeqs,
  settle,
  text,
  tick,
  timersPending,
} from "./world.js";

/** Delivers everything, letting the clients react, until nothing is left
 * to deliver once they have settled. */
export async function quiesce(
  world: World,
  clients: Client[],
  options: Options,
): Promise<void> {
  const { gate } = options;
  const { server } = world;
  for (let round = 0; ; round++) {
    if (round > 2000) throw new Error("the transport never quiesces");
    await settle(server, clients, options);
    // A deleted document opens no more: refused clients stay so.
    const refused = server.deletedBy
      ? []
      : clients.filter((client) => client.refused !== undefined);
    for (const client of refused) {
      await retire(world, client, true);
      open(world, client);
    }
    if (refused.length > 0) continue;
    const sockets = server.deliverable();
    const held = gate?.held.slice() ?? [];
    for (const work of held) gate?.release(work);
    const timers = timersPending(options);
    if (timers > 0) vi.runOnlyPendingTimers();
    if (sockets.length === 0 && held.length === 0 && timers === 0) return;
    for (const socket of sockets) {
      while (socket.replies.length > 0) socket.deliver("replies");
      while (socket.pushes.length > 0) socket.deliver("pushes");
    }
  }
}

/** One scenario; returns the problems found once everything is
 * delivered, with the steps that led there. */
export async function runScenario(
  choose: Choose,
  options: Options,
): Promise<string[]> {
  if (!options.clock) return run(choose, options);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    return await run(choose, options);
  } finally {
    vi.useRealTimers();
  }
}

export async function run(choose: Choose, options: Options): Promise<string[]> {
  const clients: Client[] = [];
  try {
    return await runWith(clients, choose, options);
  } finally {
    // Nothing of this case may run in the next one — a save timer, a
    // write or an encryption through the shared gate —, even when it
    // failed: Hegel would see other choices when it replays.
    for (const client of clients) {
      client.page.dropWrites = true;
      client.persistence?.close();
      client.handle?.close();
      client.connection?.close();
    }
  }
}

export async function runWith(
  clients: Client[],
  choose: Choose,
  options: Options,
): Promise<string[]> {
  const { gate } = options;
  const key = await generateKey();
  const server = new ScheduledServer();
  const problems: string[] = [];
  const secrets = new Secrets(server);
  server.verifiers = verifiersSync(secrets.draw());
  const world: World = {
    options,
    server,
    key,
    secrets,
    problems,
    changes: [],
    mayDelete: options.lifecycle === true && choose([false, true]),
    pendingExpiries: 0,
    presenceSent: new Set(),
  };
  server.maxMessageBytes = options.smallMessages
    ? choose([MAX_MESSAGE_BYTES, 300])
    : MAX_MESSAGE_BYTES;
  const count = choose([2, 3]);
  for (let i = 0; i < count; i++) {
    const settings = {
      maxMessageBytes: server.maxMessageBytes,
      compactionThreshold: options.compaction
        ? choose([1, 2, 3, 1000])
        : 1_000_000,
      publishIntervalMs: options.clock ? choose([0, 100]) : 0,
      reconnectDelayMs: options.clock ? choose([0, 500]) : 0,
      saveDelayMs: options.reload && options.clock ? choose([0, 1000]) : 0,
      decisions: options.decisions ?? false,
    };
    const role: Role = options.roles
      ? choose(["edit", "suggest", "read"] as const)
      : "edit";
    const client = newClient(i, settings, role);
    clients.push(client);
    open(world, client);
  }
  // Start from connected clients: the steps go to the races, not to
  // establishing connections (a drop still makes a client reconnect).
  await quiesce(world, clients, options);
  gate?.start();
  const trace: string[] = [];
  const steps = choose(
    Array.from({ length: options.maxSteps }, (_, i) => i + 1),
  );
  for (let i = 0; i < steps; i++) {
    trace.push(await step(choose, world, clients, options));
    await settle(server, clients, options);
  }
  // Draining too: in an order Hegel draws (no new write, drop or
  // decision), then in a fixed one — which alone never races.
  const draining: Move[] = ["deliver", "finish", "wait", "reopen"];
  for (let i = 0; options.gate && i < 200; i++) {
    const possible = moves(server, clients, options, false).filter((move) =>
      draining.includes(move),
    );
    if (possible.length === 0) break;
    trace.push(await step(choose, world, clients, options, choose(possible)));
    await settle(server, clients, options);
  }
  try {
    await quiesce(world, clients, options);
  } catch (error) {
    problems.push(String(error));
  }
  gate?.stop();
  // Settled once everything is delivered: none hangs (ADR-0023 §2).
  await tick();
  if (world.pendingExpiries > 0) {
    problems.push(`${world.pendingExpiries} expiry requests never settled`);
  }

  // The official client never sends what its role forbids, nor anything
  // unreadable (ADR-0019 §4): only links replaced by a rotation close,
  // and a deleted document's.
  // ADR-0025: presence is never journaled, and never sent by a reader.
  if (server.journal.some((entry) => entry.channel === "presence")) {
    problems.push("a presence frame was journaled");
  }
  if (server.presence.some(({ role }) => role === "read")) {
    problems.push("a reader sent its presence");
  }
  const unexpected = server.closes.filter(
    (code) =>
      code !== CloseCode.Revoked &&
      code !== CloseCode.Unauthenticated &&
      code !== CloseCode.Deleted,
  );
  if (unexpected.length > 0) {
    problems.push(`the server closed connections with ${unexpected}`);
  }
  if (server.deletedBy) {
    // ADR-0023: every client ends refused for good, told of the deletion
    // (4404), or told its link opens nothing (4401: it wasn't connected,
    // or it opened a new page), or cut by a rotation before (4410).
    for (const client of clients) {
      if (client.connection || client.handle) {
        problems.push(
          `client${client.index} still connected after the deletion`,
        );
      }
      const final: (number | undefined)[] = [
        CloseCode.Deleted,
        CloseCode.Unauthenticated,
        CloseCode.Revoked,
      ];
      if (!final.includes(client.refused)) {
        problems.push(
          `client${client.index} ends with ${client.refused} after the deletion`,
        );
      }
    }
    // Its own close lost, the requester gets 4401: as it is, since it
    // can't be told from links renewed meanwhile (ADR-0024).
    return problems.length === 0 ? [] : [...problems, "-- steps --", ...trace];
  }
  for (const client of clients) {
    if (!client.connection) {
      problems.push(`client${client.index} ends disconnected`);
    }
  }

  if (options.decisions) {
    // Every record decided reached the journal (at least once: a retry
    // may journal it again), and every client confirmed all of it.
    const journal = decisionSeqs(server);
    const records = new Set<string>();
    for (const entry of server.journal) {
      if (entry.channel !== "decisions") continue;
      records.add(String([...(await decrypt(key, entry.blob))]));
    }
    for (const client of clients) {
      for (let n = 1; n <= client.decided; n++) {
        if (client.lost.has(n)) continue;
        if (!records.has(String([client.index, n]))) {
          problems.push(
            `decision ${n} of client${client.index} never journaled`,
          );
        }
      }
      const seqs = client.confirmed.map((record) => record.seq);
      if (JSON.stringify(seqs) !== JSON.stringify(journal)) {
        problems.push(
          `client${client.index} confirmed decisions ${JSON.stringify(seqs)} of ${JSON.stringify(journal)}`,
        );
      }
    }
  }

  for (const channel of CHANNELS) {
    const docs = clients.map((client) => client.docs[channel]);
    // Every client holds the own operations of every client whose role
    // publishes on this channel.
    const authors = clients
      .filter((client) => mayPublish(client.role, channel))
      .map((client) => client.docs[channel]);
    for (const holder of docs) {
      for (const author of authors) {
        const own = author.oplogVersion().get(author.peerIdStr) ?? 0;
        const held = holder.oplogVersion().get(author.peerIdStr) ?? 0;
        if (held !== own) {
          problems.push(
            `${channel}: a client holds ${held} of the ${own} operations of peer ${author.peerIdStr}`,
          );
        }
      }
    }
    // Phase 7 L1: everything a store write held, and everything the pages of a
    // client wrote and still hold, reached the journal (ADR-0022).
    if (options.reload) {
      const journaled = new LoroDoc();
      const blobs = server.journal.filter((entry) => entry.channel === channel);
      const plain: Uint8Array[] = [];
      for (const entry of blobs) plain.push(await decrypt(key, entry.blob));
      importHistory(journaled, plain);
      const inJournal = journaled.oplogVersion();
      for (const client of clients) {
        if (client.localOnly.has(channel)) continue;
        for (const [peer, counter] of client.saved[channel]) {
          if ((inJournal.get(peer as `${number}`) ?? 0) < counter) {
            problems.push(
              `${channel}: client${client.index} stored ${counter} operations of peer ${peer}, the journal holds ${inJournal.get(peer as `${number}`) ?? 0}`,
            );
          }
        }
        if (!mayPublish(client.role, channel)) continue;
        const version = client.docs[channel].oplogVersion();
        for (const peer of client.peers[channel]) {
          const held = version.get(peer as `${number}`) ?? 0;
          if ((inJournal.get(peer as `${number}`) ?? 0) < held) {
            problems.push(
              `${channel}: client${client.index} holds ${held} of its own operations of peer ${peer}, the journal ${inJournal.get(peer as `${number}`) ?? 0}`,
            );
          }
        }
      }
    }

    // Every client holds every adopted change.
    for (const change of channel === "content" ? world.changes : []) {
      for (const [i, doc] of docs.entries()) {
        const adoptedSomewhere = clients.some((client) =>
          client.adopted.includes(change.bytes),
        );
        const held = doc.oplogVersion().get(change.peer as `${number}`);
        if (adoptedSomewhere && held === undefined) {
          problems.push(`client${i} lacks adopted change ${change.peer}`);
        }
      }
    }
    const texts = clients
      .filter((client) => !client.localOnly.has(channel))
      .map((client) => text(client.docs[channel]));
    if (new Set(texts).size > 1) {
      problems.push(`${channel} diverged: ${JSON.stringify(texts)}`);
    }

    // The journal alone gives them all to a newcomer.
    const entries = server.journal.filter((entry) => entry.channel === channel);
    const updates: Uint8Array[] = [];
    for (const entry of entries) updates.push(await decrypt(key, entry.blob));
    const newcomer = new LoroDoc();
    importHistory(newcomer, updates);
    if (texts.length > 0 && text(newcomer) !== texts[0]) {
      problems.push(
        `${channel}: the journal gives ${JSON.stringify(text(newcomer))}, clients hold ${JSON.stringify(texts[0])}`,
      );
    }

    // I4 (ADR-0017, extended by R-A1): an entry depends only on entries
    // journaled before it — imported one by one, nothing ever waits.
    const inOrder = new LoroDoc();
    for (const [i, update] of updates.entries()) {
      const status = inOrder.import(update);
      if (status.pending) {
        problems.push(
          `${channel}: entry ${entries[i]?.seq} depends on a later entry`,
        );
        break;
      }
    }

    // One entry, one author (ADR-0015): a single peer, or the peers of the
    // pages of a single client — a reloaded page publishes what its
    // previous pages left unacked (ADR-0022, R-L1).
    for (const entry of entries) {
      const authors = await authorsOf(key, entry.blob);
      const oneClient = (peers: string[]) =>
        clients.some((client) =>
          peers.every((peer) => client.peers[channel].has(peer)),
        );
      if (authors && authors.length !== 1 && !oneClient(authors)) {
        problems.push(
          `${channel}: entry ${entry.seq} carries the operations of peers ${authors.join(", ")}`,
        );
      }
    }
  }
  return problems.length === 0 ? [] : [...problems, "-- steps --", ...trace];
}
