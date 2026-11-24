// @vitest-environment node
//
// Starting over the identity's list (docs/phase-18-trousseau-identite.md,
// analysis 18p.3, RL2, RL3, interleavings 1 – 6; KR-45; AGENTS.md §1.6).
// The identity's list is at the gateway under a key that only an old
// device holds; this device holds a list in waiting, by link, or none.
// Two tabs of this device, one of the old device, each writing its own
// documents; this device's first tab starts over when the test says, and
// the old device may start over too (interleaving 2). Every source of
// order is a choice of the test: when the gateway and the server take
// each request, when each encryption and decryption ends (`cryptoGate`),
// when each write to a device's copy ends, when each timer fires, when a
// tab is reloaded, when a device is signed out and in again.
// At each step: a blob that doesn't read under a list's key is written
// over only by a list this device started over (RL3). At the end, every
// device given the key of the list that won (KR-30): every document a tab
// was promised is in it, the old device's included, and the list in
// waiting is deleted (KR-29).
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc } from "loro-crdt";
import { describe, expect, test, vi } from "vitest";
import {
  type KeyringCredentials,
  type KeyringTransport,
  SignedOut,
  decryptKeyring,
  encryptKeyring,
  listKeyring,
  newKeyringDoc,
  newKeyringSecrets,
  readKeyringPlaintext,
  rememberLink,
} from "../../lib/src/index.js";
import { testLink } from "../../lib/src/keyring/test-support/links.js";
import { cryptoGate } from "../../lib/src/transport/test-support/crypto-gate.js";
import { eventually } from "../../lib/src/transport/test-support/eventually.js";
import type { KeyringLocal, StoredKeyring } from "./local.js";
import {
  type AccountKeyring,
  type KeyringRef,
  formatKeyringRef,
  isAccountKeyring,
  sameKeyring,
} from "./ref.js";
import { KeyringSession, type KeyringSessionOptions } from "./session.js";

// The gate imported here: the library's entry, imported above, loads this
// module before the test's own imports are bound.
vi.mock("../../lib/src/keyring/crypto.js", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../../lib/src/keyring/crypto.js")>();
  const { cryptoGate } = await import(
    "../../lib/src/transport/test-support/crypto-gate.js"
  );
  return {
    ...real,
    encryptKeyring: cryptoGate.wrap("encrypt", real.encryptKeyring),
    decryptKeyring: cryptoGate.wrap("decrypt", real.decryptKeyring),
  };
});

type TC = Parameters<Parameters<typeof hegel.testAsync>[0]>[0];

const identity = (key: Uint8Array): AccountKeyring => ({
  gateway: "https://accounts.example",
  issuer: "https://idp.example",
  sub: "u-1",
  key,
});
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
/** A list's name in `replaced`: a link's identifier, an account's key. */
const nameOf = (ref: KeyringRef) =>
  isAccountKeyring(ref) ? `account:${hex(ref.key)}` : ref.keyringId;

/** The gateway's keyring of the identity (KR-39) and the server's
 * keyrings by link (KR-6, KR-7, KR-10): each request waits for the test.
 * Each blob is known by the key that wrote it, and every write accepted
 * over another key's blob is checked as it is taken (RL3). */
class Network {
  version = 1;
  blob: Uint8Array = new Uint8Array();
  readonly keyOf = new Map<Uint8Array, string>();
  readonly links = new Map<
    string,
    { version: number; blob: Uint8Array; deleted: boolean }
  >();
  readonly signedOut = new Set<number>();
  readonly pending: (() => void)[] = [];
  readonly faults: string[] = [];

  private later<T>(take: () => T): Promise<T> {
    return new Promise((resolve) => this.pending.push(() => resolve(take())));
  }

  transport(
    device: number,
    ref: KeyringRef,
    copy: DeviceCopy,
  ): KeyringTransport {
    if (!isAccountKeyring(ref)) {
      const slot = () => this.links.get(ref.keyringId);
      return {
        read: () =>
          this.later(() => {
            const kept = slot();
            return !kept || kept.deleted
              ? ("missing" as const)
              : { version: kept.version, blob: kept.blob };
          }),
        write: (version, blob) =>
          this.later(() => {
            const kept = slot();
            if (!kept || kept.deleted) return "missing" as const;
            if (version !== kept.version) return { stale: kept.version };
            kept.version += 1;
            kept.blob = blob;
            return { written: kept.version };
          }),
      };
    }
    const key = hex(ref.key);
    const signedIn = <T>(take: () => T) =>
      this.signedOut.has(device)
        ? Promise.reject(new SignedOut())
        : this.later(take);
    return {
      read: () => signedIn(() => ({ version: this.version, blob: this.blob })),
      write: (version, blob) =>
        signedIn(() => {
          if (version !== this.version) return { stale: this.version };
          const over = this.keyOf.get(this.blob);
          // RL3: never over another key's list, but by a list this
          // device started over. (Another tab's sync, begun under the
          // note, may still write once after the note is cleared:
          // analysis 18p.3, case 9.)
          if (over !== key && !copy.noted.has(formatKeyringRef(ref)))
            this.faults.push(`device ${device} wrote over, never started over`);
          this.version += 1;
          this.blob = blob;
          this.keyOf.set(blob, key);
          return { written: this.version };
        }),
    };
  }

  remove(credentials: KeyringCredentials): Promise<"deleted" | "missing"> {
    return this.later(() => {
      const kept = this.links.get(credentials.keyringId);
      if (!kept || kept.deleted) return "missing" as const;
      kept.deleted = true;
      return "deleted" as const;
    });
  }
}

/** A device's copy (local.ts's contract, in memory): one write at a time
 * (the lock), each landing when the test says. */
class DeviceCopy {
  stored: { ref: KeyringRef; snapshot: Uint8Array } | undefined;
  retiredLinks: KeyringCredentials[] = [];
  replaced = new Map<string, string>();
  /** The list started over (RL2), by its reference. */
  note: string | undefined;
  /** Every list ever started over here. */
  readonly noted = new Set<string>();
  readonly landing: (() => void)[] = [];
  private tail: Promise<unknown> = Promise.resolve();

  private turn<T>(work: () => T): Promise<T> {
    const run = this.tail.then(
      () =>
        new Promise<T>((resolve, reject) =>
          this.landing.push(() => {
            try {
              resolve(work());
            } catch (error) {
              reject(error);
            }
          }),
        ),
    );
    this.tail = run.catch(() => {});
    return run;
  }

  private keep(ref: KeyringRef, doc: LoroDoc): void {
    // As local.ts: another list written here drops the note.
    if (this.note !== formatKeyringRef(ref)) this.note = undefined;
    this.stored = { ref, snapshot: doc.export({ mode: "snapshot" }) };
  }

  local(): KeyringLocal {
    const unused = async (): Promise<never> => {
      throw new Error("not in this scenario");
    };
    return {
      load: async (): Promise<StoredKeyring | undefined> => {
        if (!this.stored) return undefined;
        const doc = new LoroDoc();
        doc.import(this.stored.snapshot);
        return { ref: this.stored.ref, doc };
      },
      save: (ref, doc) =>
        this.turn(() => {
          if (this.stored && !sameKeyring(this.stored.ref, ref))
            return "superseded" as const;
          if (this.stored) doc.import(this.stored.snapshot);
          this.keep(ref, doc);
          return "saved" as const;
        }),
      replace: (ref, doc) => this.turn(() => this.keep(ref, doc)),
      claim: unused,
      join: unused,
      rotate: unused,
      forget: unused,
      startOver: (next, doc, current) =>
        this.turn(() => {
          const here = this.stored?.ref;
          const known =
            !here ||
            (current !== undefined && sameKeyring(here, current)) ||
            sameKeyring(here, next);
          if (!known) return "taken" as const;
          if (this.stored) doc.import(this.stored.snapshot);
          this.stored = {
            ref: next,
            snapshot: doc.export({ mode: "snapshot" }),
          };
          this.note = formatKeyringRef(next);
          this.noted.add(this.note);
          if (here && !isAccountKeyring(here)) {
            this.replaced.set(here.keyringId, nameOf(next));
            this.retiredLinks.push(here);
          }
          return "started" as const;
        }),
      startingOver: async (ref) =>
        this.stored !== undefined &&
        sameKeyring(this.stored.ref, ref) &&
        this.note === formatKeyringRef(ref),
      clearStartOver: (ref) =>
        this.turn(() => {
          if (this.note === formatKeyringRef(ref)) this.note = undefined;
        }),
      retired: async () => [...this.retiredLinks],
      clearRetired: (old, options) =>
        this.turn(() => {
          if (
            options?.ifStored &&
            (!this.stored || nameOf(this.stored.ref) !== old.keyringId)
          )
            return;
          this.retiredLinks = this.retiredLinks.filter(
            (l) => l.keyringId !== old.keyringId,
          );
        }),
      successor: async (ref) => {
        if (isAccountKeyring(ref) || !this.stored) return undefined;
        const here = this.stored.ref;
        if (sameKeyring(here, ref)) return undefined;
        const target = nameOf(here);
        let at: string | undefined = ref.keyringId;
        while (at !== undefined && at !== target) at = this.replaced.get(at);
        if (at !== target) return undefined;
        const doc = new LoroDoc();
        doc.import(this.stored.snapshot);
        return { ref: here, doc };
      },
    };
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("starting over the identity's list", () => {
  test(
    "whatever the order, a list that doesn't read is written over only by one started over, and nothing promised is lost",
    () =>
      hegel.testAsync(
        async (tc: TC) => {
          const network = new Network();
          const copies = [new DeviceCopy(), new DeviceCopy()];
          const TABS = [0, 0, 1]; // the device of each tab
          // The old device holds the identity's list, a document in it.
          const oldKey = newKeyringSecrets().key;
          const old = newKeyringDoc();
          rememberLink(old, testLink("old-0"), { at: 1 });
          network.blob = await encryptKeyring(
            oldKey,
            old.export({ mode: "snapshot" }),
          );
          network.keyOf.set(network.blob, hex(oldKey));
          (copies[1] as DeviceCopy).stored = {
            ref: identity(oldKey),
            snapshot: old.export({ mode: "snapshot" }),
          };
          // This device: a list in waiting, a document in it, or none.
          let waiting: KeyringCredentials | undefined;
          if (tc.draw(gs.booleans())) {
            waiting = { keyringId: "ab".repeat(16), ...newKeyringSecrets() };
            const doc = newKeyringDoc();
            rememberLink(doc, testLink("waiting-0"), { at: 1 });
            network.links.set(waiting.keyringId, {
              version: 1,
              blob: await encryptKeyring(
                waiting.key,
                doc.export({ mode: "snapshot" }),
              ),
              deleted: false,
            });
            (copies[0] as DeviceCopy).stored = {
              ref: waiting,
              snapshot: doc.export({ mode: "snapshot" }),
            };
          }
          cryptoGate.start();
          try {
            const timers: { run: () => void; live: boolean }[] = [];
            const options = (tab: number): KeyringSessionOptions => {
              const device = TABS[tab] as number;
              const copy = copies[device] as DeviceCopy;
              return {
                local: copy.local(),
                transport: (ref) => network.transport(device, ref, copy),
                remove: (credentials) => network.remove(credentials),
                setTimer: (run) => {
                  const timer = { run, live: true };
                  timers.push(timer);
                  return () => {
                    timer.live = false;
                  };
                },
              };
            };
            /** Until nothing runs that the test doesn't time. */
            const settle = async () => {
              do {
                await eventually(() => cryptoGate.running === 0);
                await flush();
                await flush();
              } while (cryptoGate.running > 0);
            };
            const sessions: (KeyringSession | undefined)[] = [];
            for (const tab of TABS.keys())
              sessions[tab] = await KeyringSession.open(options(tab));
            const pages = TABS.map(() => ({}));
            const promised = TABS.map(() => new Set<string>());
            const written = TABS.map(() => 0);
            let clock = 1;
            /** Per device: started over already. */
            const started = [false, false];
            const startOver = (tab: number) => {
              const device = TABS[tab] as number;
              started[device] = true;
              const current = sessions[tab];
              // KR-44: the list in waiting's own key, else a new one.
              const key =
                current && !isAccountKeyring(current.ref)
                  ? current.ref.key
                  : newKeyringSecrets().key;
              const page = pages[tab];
              void KeyringSession.startOver(
                options(tab),
                identity(key),
                current?.doc ?? newKeyringDoc(),
                current?.ref,
              ).then(
                async (next) => {
                  if (pages[tab] !== page) {
                    next?.close();
                    return;
                  }
                  sessions[tab]?.close();
                  sessions[tab] =
                    next ?? (await KeyringSession.open(options(tab)));
                },
                () => {},
              );
            };

            for (
              let step = tc.draw(gs.integers({ minValue: 1, maxValue: 40 }));
              step > 0;
              step--
            ) {
              const moves = ["write", "write", "reload", "sign-out"];
              if (!started[0]) moves.push("start-over", "start-over");
              if (!started[1] && started[0]) moves.push("old-starts-over");
              if (network.pending.length > 0)
                moves.push("serve", "serve", "serve");
              if (copies.some((c) => c.landing.length > 0))
                moves.push("land", "land", "land");
              if (cryptoGate.held.length > 0)
                moves.push("crypto", "crypto", "crypto");
              if (timers.some((t) => t.live)) moves.push("timer", "timer");
              const move = tc.draw(gs.sampledFrom(moves));
              const tab = tc.draw(
                gs.integers({ minValue: 0, maxValue: TABS.length - 1 }),
              );
              const session = sessions[tab];
              if (move === "write" && session) {
                const doc = `t${tab}-${written[tab]}`;
                written[tab] = (written[tab] as number) + 1;
                session
                  .change(
                    (d) => void rememberLink(d, testLink(doc), { at: ++clock }),
                  )
                  .then(
                    (outcome) => {
                      if (outcome === "saved") promised[tab]?.add(doc);
                    },
                    () => {},
                  );
              } else if (move === "reload") {
                session?.close();
                pages[tab] = {};
                sessions[tab] = await KeyringSession.open(options(tab));
              } else if (move === "sign-out") {
                // Out, or in again: then its tabs sync, as the home does.
                const device = TABS[tab] as number;
                if (network.signedOut.delete(device)) {
                  for (const [t, d] of TABS.entries())
                    if (d === device) void sessions[t]?.sync();
                } else network.signedOut.add(device);
              } else if (move === "start-over") {
                startOver(0);
              } else if (move === "old-starts-over") {
                startOver(2);
              } else if (move === "serve") {
                const i = tc.draw(
                  gs.integers({
                    minValue: 0,
                    maxValue: network.pending.length - 1,
                  }),
                );
                network.pending.splice(i, 1)[0]?.();
              } else if (move === "land") {
                const copy = tc.draw(
                  gs.sampledFrom(copies.filter((c) => c.landing.length > 0)),
                );
                copy.landing.shift()?.();
              } else if (move === "crypto") {
                const i = tc.draw(
                  gs.integers({
                    minValue: 0,
                    maxValue: cryptoGate.held.length - 1,
                  }),
                );
                const held = cryptoGate.held[i];
                if (held) cryptoGate.release(held);
              } else if (move === "timer") {
                const timer = tc.draw(
                  gs.sampledFrom(timers.filter((t) => t.live)),
                );
                timer.live = false;
                timer.run();
              }
              await settle();
              expect(network.faults).toEqual([]);
            }

            // The end: signed in, everything let through, in order.
            const drain = async () => {
              for (let i = 0; i < 10_000; i++) {
                await settle();
                const held = cryptoGate.held[0];
                if (held) {
                  cryptoGate.release(held);
                  continue;
                }
                const land = copies.find((c) => c.landing.length > 0)?.landing;
                if (land) {
                  land.shift()?.();
                  continue;
                }
                const request = network.pending.shift();
                if (request) {
                  request();
                  continue;
                }
                const timer = timers.find((t) => t.live);
                if (timer) {
                  timer.live = false;
                  timer.run();
                  continue;
                }
                return;
              }
              throw new Error("never drains");
            };
            network.signedOut.clear();
            await drain();
            if (!started[0]) {
              startOver(0);
              await drain();
            }
            // Every tab reloaded: one still on the list in waiting follows
            // the list that replaced it only at its next write (RA2); one
            // reloaded before its device's list was stored opens it now.
            const reloadAll = async () => {
              for (const t of TABS.keys()) {
                sessions[t]?.close();
                sessions[t] = await KeyringSession.open(options(t));
              }
            };
            await reloadAll();
            const syncAll = async () => {
              for (const session of sessions) {
                void session?.sync();
                await drain();
              }
            };
            await syncAll();
            expect(network.faults).toEqual([]);
            // The list that won: whoever started over last. Every other
            // device is given its key (KR-30): its copy merged into it.
            const won = identity(
              Buffer.from(network.keyOf.get(network.blob) as string, "hex"),
            );
            // A list started over, everything let through, is written:
            // the server holds one of them, never the old one (RL3).
            expect(copies.some((c) => c.noted.has(formatKeyringRef(won)))).toBe(
              true,
            );
            for (const [device, copy] of copies.entries()) {
              const stored = copy.stored;
              if (!stored || sameKeyring(stored.ref, won)) continue;
              const tabs = [...TABS.keys()].filter((t) => TABS[t] === device);
              for (const t of tabs) sessions[t]?.close();
              const doc = new LoroDoc();
              doc.import(stored.snapshot);
              const given = KeyringSession.adopt(
                options(tabs[0] as number),
                won,
                doc,
                true,
              );
              await drain();
              (await given)?.close();
              for (const t of tabs)
                sessions[t] = await KeyringSession.open(options(t));
            }
            await reloadAll();
            for (let round = 0; round < 2; round++) await syncAll();
            for (const session of sessions) {
              const status = session?.sync();
              await drain();
              expect(await status).toBe("synced");
            }
            expect(network.faults).toEqual([]);

            cryptoGate.stop();
            const list = readKeyringPlaintext(
              await decryptKeyring(won.key, network.blob),
            ) as LoroDoc;
            const listed = new Set(listKeyring(list).map((e) => e.documentId));
            expect(listed.has("old-0")).toBe(true);
            if (waiting) {
              expect(listed.has("waiting-0")).toBe(true);
              // KR-29: the list in waiting, once replaced, deleted.
              expect(network.links.get(waiting.keyringId)?.deleted).toBe(true);
            }
            for (const mine of promised)
              for (const doc of mine) expect(listed.has(doc), doc).toBe(true);
            for (const session of sessions) session?.close();
          } finally {
            cryptoGate.stop();
          }
        },
        { testCases: 150 },
      ),
    600_000,
  );
});
