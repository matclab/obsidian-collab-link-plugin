// The moves of the publication scenario: which are possible now, and
// what each does.
import { LoroDoc } from "loro-crdt";
import { vi } from "vitest";
import { mayPublish } from "../../../lib/src/transport/protocol.js";
import type {
  ScheduledServer,
  ScheduledSocket,
} from "../../../lib/src/transport/test-support/scheduled-server.js";
import { verifiersSync } from "../../../lib/src/transport/test-support/verifiers.js";
import { checkStored, open, retire } from "./client.js";
import {
  CHANNELS,
  type Choose,
  type Client,
  type Options,
  type World,
  settle,
  text,
  timersPending,
} from "./world.js";

export type Move =
  | "write"
  | "deliver"
  | "drop"
  | "finish"
  | "wait"
  | "decide"
  | "rotate"
  | "reopen"
  | "adopt"
  | "reload"
  | "closeView"
  | "expire"
  | "delete"
  | "rotateThenDelete"
  | "renewTwice"
  | "presence"
  | "unknown"
  | "strayAck";

/** Connections a server extension could send to: authenticated, not
 * closed yet. */
export const extensible = (server: ScheduledServer) =>
  server.sockets.filter((socket) => !socket.dead && socket.role !== undefined);

/** What a later extension of the server may send (phase 8, N4). */
export const UNKNOWN_MESSAGES = [
  // Shaped like an ack: taken for one, it would pair with a frame of the
  // client's that the server never journaled.
  (seq: number) =>
    JSON.stringify({ receipt: "content", channel: "content", seq }),
  (seq: number) => JSON.stringify({ channel: "annotations", seq }),
  (seq: number) => JSON.stringify({ notice: "hello", expires_at: seq }),
  () => new Uint8Array([9, 1, 2, 3]).buffer,
  // A known message it can't read (G1): it closes and resumes.
  (seq: number) => JSON.stringify({ ack: "content", seq: String(seq) }),
  // The same, for the readings phase 9 aligned on the specification
  // (C1): a seq that isn't a non-negative integer below 2^53 (W-2),
  // a text that isn't an object, a blob without its padding (W-1).
  (seq: number) => JSON.stringify({ ack: "content", seq: seq + 0.5 }),
  (seq: number) => JSON.stringify({ ack: "annotations", seq: -seq }),
  (seq: number) => JSON.stringify([{ ack: "content", seq }]),
  (seq: number) =>
    JSON.stringify({ history: [{ channel: "content", seq, blob: "AQ" }] }),
  (seq: number) => JSON.stringify({ expiry: -seq }),
];

/** Inserts `data` into a queue of `socket`, anywhere after the
 * authentication reply if it is still queued (the server sends nothing
 * before it); returns where. */
export function slip(
  choose: Choose,
  socket: ScheduledSocket,
  queue: "replies" | "pushes",
  message: { data: string | ArrayBuffer } | { strayAck: number },
): number {
  const auth = socket.replies.findIndex(
    (message) =>
      typeof message === "object" &&
      "data" in message &&
      typeof message.data === "string" &&
      message.data.includes('"authenticated"'),
  );
  const from = queue === "replies" ? auth + 1 : 0;
  const target = socket[queue];
  const at = choose(
    Array.from({ length: target.length - from + 1 }, (_, i) => from + i),
  );
  target.splice(at, 0, message);
  return at;
}

/** The moves that can do something now — a draw spent on one that
 * can't is a step lost for the races (a third of them, before). */
export const connectedEditor = (client: Client) =>
  client.connection !== undefined && client.role === "edit";

export function moves(
  server: ScheduledServer,
  clients: Client[],
  options: Options,
  mayDelete = false,
): Move[] {
  const can = (move: Move, weight: number, possible: boolean) =>
    possible ? Array<Move>(weight).fill(move) : [];
  return [
    "write",
    ...can("deliver", 3, server.deliverable().length > 0),
    ...can(
      "drop",
      1,
      server.sockets.some((socket) => !socket.dead),
    ),
    ...can("finish", 3, (options.gate?.held.length ?? 0) > 0),
    ...can("wait", 2, timersPending(options) > 0),
    ...can(
      "decide",
      1,
      options.decisions === true && clients.some(connectedEditor),
    ),
    ...can(
      "rotate",
      1,
      options.rotation === true && clients.some(connectedEditor),
    ),
    ...can(
      "adopt",
      2,
      options.adoption === true &&
        clients.some((client) => client.handle && client.role === "edit"),
    ),
    ...can(
      "reopen",
      2,
      !server.deletedBy &&
        clients.some((client) => client.refused !== undefined),
    ),
    ...can(
      "expire",
      1,
      options.lifecycle === true && clients.some(connectedEditor),
    ),
    ...can(
      "delete",
      1,
      mayDelete && !server.deletedBy && clients.some(connectedEditor),
    ),
    ...can(
      "presence",
      2,
      options.presence === true && clients.some((client) => client.handle),
    ),
    ...can(
      "unknown",
      2,
      options.unknown === true && extensible(server).length > 0,
    ),
    ...can(
      "strayAck",
      2,
      options.unknown === true && extensible(server).length > 0,
    ),
    ...can(
      "renewTwice",
      1,
      options.rotation === true && clients.some(connectedEditor),
    ),
    ...can(
      "rotateThenDelete",
      1,
      mayDelete &&
        options.rotation === true &&
        !server.deletedBy &&
        clients.filter(connectedEditor).length >= 2,
    ),
    ...can(
      "reload",
      1,
      options.reload === true && clients.some((client) => client.handle),
    ),
    ...can(
      "closeView",
      1,
      options.reload === true && clients.some((client) => client.persistence),
    ),
  ];
}

export async function step(
  choose: Choose,
  world: World,
  clients: Client[],
  options: Options,
  move: Move = choose(moves(world.server, clients, options, world.mayDelete)),
): Promise<string> {
  const { gate } = options;
  const { server } = world;
  switch (move) {
    case "expire": {
      const client = choose(clients.filter(connectedEditor));
      if (!client.connection) throw new Error("unreachable");
      const inSeconds = choose([60, null]);
      const expected = inSeconds === null ? null : server.now + inSeconds;
      world.pendingExpiries++;
      client.connection
        .setExpiry(inSeconds)
        .then(
          (expiresAt) => {
            if (expiresAt !== expected) {
              world.problems.push(
                `client${client.index} set the expiry to ${expected}, got ${expiresAt}`,
              );
            }
          },
          () => {}, // not sent, or the connection dropped first
        )
        .finally(() => world.pendingExpiries--);
      return `client${client.index} sets the expiry (${inSeconds})`;
    }
    case "presence": {
      // Any page, whatever its role: a reader's state must never leave.
      const client = choose(clients.filter((client) => client.handle));
      const state = `presence ${client.index}.${client.epoch}.${world.presenceSent.size}`;
      world.presenceSent.add(state);
      client.handle?.publishPresence(new TextEncoder().encode(state));
      return `client${client.index} sends its presence`;
    }
    case "unknown": {
      const socket = choose(extensible(world.server));
      const queue = choose(["replies", "pushes"] as const);
      const make = choose(UNKNOWN_MESSAGES);
      const at = slip(choose, socket, queue, {
        data: make(choose([1, 2, 3, 1000])),
      });
      return `the server sends an unknown message on connection ${world.server.sockets.indexOf(socket)} (${queue}, at ${at})`;
    }
    case "strayAck": {
      // An ack the client can tell is stray (G1): of a channel the
      // connection never sent on, fixed when delivered (see
      // `ScheduledSocket.strayAck`). Taken for the ack of the oldest
      // frame, it would pair with one the server may never have
      // journaled. The client closes and resumes; nothing may be lost.
      const socket = choose(extensible(world.server));
      const at = slip(choose, socket, "replies", {
        strayAck: choose([1, 1000]),
      });
      return `the server sends a stray ack on connection ${world.server.sockets.indexOf(socket)} (at ${at})`;
    }
    case "renewTwice": {
      // Drawn as one move: "Renew" clicked again once the first renewal
      // was answered, before its close arrived. The first one passed.
      const client = choose(clients.filter(connectedEditor));
      const first = await step(choose, world, [client], options, "rotate");
      const socket = client.sockets.at(-1);
      if (socket && socket.replies.length > 0) socket.deliver("replies");
      await settle(server, clients, options);
      // What was delivered may have been a close queued before.
      if (!connectedEditor(client)) return `${first}; then cut`;
      const second = await step(choose, world, [client], options, "rotate");
      return `${first}, answered; ${second}`;
    }
    case "rotateThenDelete": {
      // Drawn as one move (left to chance, the sequence is too rare): an
      // editor renews the links, another deletes before it learns that
      // cut it — its deletion is refused, never reported as passed.
      const editors = clients.filter(connectedEditor);
      const rotator = choose(editors);
      const deleter = choose(editors.filter((client) => client !== rotator));
      const first = await step(choose, world, [rotator], options, "rotate");
      const second = await step(choose, world, [deleter], options, "delete");
      return `${first}; ${second}`;
    }
    case "delete": {
      const client = choose(clients.filter(connectedEditor));
      if (!client.connection) throw new Error("unreachable");
      try {
        client.connection.deleteDocument();
      } catch {
        return `client${client.index} can't delete: reconnecting`;
      }
      return `client${client.index} deletes the document`;
    }
    case "rotate": {
      const client = choose(clients.filter(connectedEditor));
      if (!client.connection) throw new Error("unreachable");
      const secret = world.secrets.draw();
      client.rotatedTo.push(secret);
      const verifiers = verifiersSync(secret);
      const bytes = (role: keyof typeof verifiers) =>
        new Uint8Array(Buffer.from(verifiers[role], "base64url"));
      client.connection
        .rotate({
          secret,
          verifiers: {
            read: bytes("read"),
            suggest: bytes("suggest"),
            edit: bytes("edit"),
          },
        })
        .catch(() => {}); // outcome unknown: R-B4
      return `client${client.index} renews the links (secret ${secret[0]})`;
    }
    case "adopt": {
      // What an editor does when it applies an acceptance: imports the
      // change, a new one (a reviewer's, made on a fork with its own peer)
      // or one another editor adopted already, and adopts it in the same
      // turn — unless it holds it already (`checkDetachedChange` says
      // `present`).
      const client = choose(
        clients.filter((client) => client.handle && client.role === "edit"),
      );
      const doc = client.docs.content;
      const fresh = world.changes.length === 0 || choose([true, false]);
      let change = world.changes[0];
      if (fresh) {
        const fork = doc.fork();
        const peer = BigInt(1000 + world.changes.length);
        fork.setPeerId(peer);
        const before = fork.oplogVersion();
        const target = fork.getText("t");
        target.insert(
          choose(Array.from({ length: target.length + 1 }, (_, i) => i)),
          "x",
        );
        fork.commit();
        change = {
          peer: String(peer),
          bytes: fork.export({ mode: "update", from: before }),
        };
        world.changes.push(change);
      } else {
        change = choose(world.changes);
      }
      if (!change) throw new Error("unreachable");
      if (doc.oplogVersion().get(change.peer as `${number}`) !== undefined) {
        return `client${client.index} holds change ${change.peer} already`;
      }
      if (doc.fork().import(change.bytes).pending) {
        // its dependencies aren't here (`checkDetachedChange`: pending)
        return `client${client.index} waits for change ${change.peer}`;
      }
      doc.import(change.bytes);
      client.adopted.push(change.bytes);
      client.handle?.adopt("content", change.bytes);
      return `client${client.index} adopts change ${change.peer}`;
    }
    case "reopen": {
      const client = choose(
        clients.filter((client) => client.refused !== undefined),
      );
      const code = client.refused;
      const applyHeld = choose([true, false]);
      await retire(world, client, applyHeld);
      await checkStored(world, client);
      open(world, client);
      return `client${client.index}, refused (${code}), opens the current link (held write ${applyHeld ? "done" : "never made"})`;
    }
    case "reload": {
      // The tab reloads, or closes and is opened again: on its way out it
      // may flush (pagehide), and a write it started may or may not have
      // created its transaction.
      const client = choose(clients.filter((client) => client.handle));
      const flush = choose([true, false]);
      // No write in progress: the flush's is the page's last, and holds
      // all of it (ADR-0022: a normal close loses nothing).
      const quiet = !gate?.held.some((held) =>
        held.label.startsWith(`store c${client.index} `),
      );
      const before = CHANNELS.map((channel) => ({
        channel,
        version: client.docs[channel].oplogVersion(),
      }));
      if (flush) client.persistence?.flush();
      await settle(server, clients, options);
      const applyHeld = choose([true, false]);
      await retire(world, client, applyHeld);
      if (flush && quiet && applyHeld) {
        for (const { channel, version } of before) {
          const stored = client.stored?.channels.find(
            (stored) => stored.channel === channel,
          );
          const doc = new LoroDoc();
          if (stored) doc.import(stored.snapshot);
          const order = doc.oplogVersion().compare(version);
          if (order === undefined || order < 0) {
            world.problems.push(
              `client${client.index} closed after a flush, its ${channel} record lacks what the page held`,
            );
          }
        }
      }
      await checkStored(world, client);
      open(world, client);
      return `client${client.index} reloads (flush ${flush}, held write ${applyHeld ? "done" : "never made"})`;
    }
    case "closeView": {
      // The plugin's tab closes while Obsidian lives on: no pagehide, the view
      // drains its saves — the one
      // under way, then one with what changed meanwhile — while the
      // network goes on delivering; the store's writes end when the test
      // says. Analysis 14c, NE6: the record then holds all the view held.
      const client = choose(clients.filter((client) => client.persistence));
      const before = CHANNELS.map((channel) => ({
        channel,
        version: client.docs[channel].oplogVersion(),
      }));
      let drained = false;
      const draining = client.persistence?.drain().then(() => {
        drained = true;
      });
      for (let turn = 0; !drained; turn++) {
        if (turn > 50) throw new Error("the view's drain never ends");
        const mine = gate?.held.filter((held) =>
          held.label.startsWith(`store c${client.index} `),
        );
        if (mine?.length) gate?.release(choose(mine));
        await settle(server, clients, options);
      }
      await draining;
      await retire(world, client, true);
      for (const { channel, version } of before) {
        const stored = client.stored?.channels.find(
          (stored) => stored.channel === channel,
        );
        const doc = new LoroDoc();
        if (stored) doc.import(stored.snapshot);
        const order = doc.oplogVersion().compare(version);
        if (order === undefined || order < 0) {
          world.problems.push(
            `client${client.index}'s view closed, its ${channel} record lacks what it held`,
          );
        }
      }
      await checkStored(world, client);
      open(world, client);
      return `client${client.index}'s view closes, draining its saves`;
    }
    case "decide": {
      const client = choose(clients.filter(connectedEditor));
      if (!client.connection) throw new Error("unreachable");
      client.decided++;
      client.undelivered.add(client.decided);
      client.connection.publishDecision(
        new Uint8Array([client.index, client.decided]),
      );
      client.persistence?.changed();
      return `client${client.index} decides ${client.decided}`;
    }
    case "wait": {
      if (vi.getTimerCount() === 0) return "nothing to wait for";
      vi.advanceTimersToNextTimer();
      return `time passes: ${Date.now()}`;
    }
    case "finish": {
      if (!gate || gate.held.length === 0) return "nothing to finish";
      const held = choose(gate.held);
      gate.release(held);
      return `finish ${held.label}`;
    }
    case "write": {
      // Anywhere, whatever the role: what its role may not publish must
      // stay local (the page never lets it happen: a read-only editor,
      // the panel's actions; the transport guards it all the same).
      const client = choose(clients);
      const channel = choose(CHANNELS);
      if (!mayPublish(client.role, channel)) client.localOnly.add(channel);
      const doc = client.docs[channel];
      const target = doc.getText("t");
      const at = choose(Array.from({ length: target.length + 1 }, (_, i) => i));
      const length = options.smallMessages ? choose([1, 200]) : 1;
      target.insert(at, String(client.index).repeat(length));
      doc.commit();
      return `client${client.index} writes ${length} on ${channel}`;
    }
    case "deliver": {
      const sockets = server.deliverable();
      if (sockets.length === 0) return "nothing to deliver";
      const socket = choose(sockets);
      const queues = (["replies", "pushes"] as const).filter(
        (queue) => socket[queue].length > 0,
      );
      const queue = choose(queues);
      socket.deliver(queue);
      return `deliver ${queue} on connection ${server.sockets.indexOf(socket)}`;
    }
    case "drop": {
      const live = server.sockets.filter((socket) => !socket.dead);
      if (live.length === 0) return "nothing to drop";
      const socket = choose(live);
      socket.drop();
      return `drop connection ${server.sockets.indexOf(socket)}`;
    }
  }
}
