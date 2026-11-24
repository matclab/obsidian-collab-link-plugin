// @vitest-environment node
//
// The keyring across tabs and devices (docs/phase-18-trousseau-identite.md,
// analysis 18d, cases 1 – 6; TR1, TR2; AGENTS.md §1.6). Two tabs of one
// device and a tab of another write the same keyring, each its own
// documents; a write is a link remembered, a rotation a document's new link.
// Every source of order is a choice of the test: when the server takes each
// request, when each write to the device's copy ends, when each encryption
// and decryption ends (`cryptoGate`), when each timer fires, when a tab is
// reloaded — its writes in progress landing or not —, when a device goes
// offline, and whether the keyring is deleted on the server. A tab may
// also be reloaded into a pairing (analysis 18f, case 5): it receives the
// keyring from another device, joined to its device's copy under the
// copy's queue, while the other tabs write.
// The keyring may be an account's, on a gateway (analysis 18i.3, cases 1,
// 4, 5; TR6, TR7): every request then asks the device for its token of the
// moment (`accountToken`, through `httpAccountKeyringTransport`), and the
// test chooses when a token expires at the gateway, when a device signs
// out, when another account signs in on it, and when it signs in again —
// which syncs its tabs, as the home does.
// At the end, every device signed in again: everything a tab was promised
// (a write resolved) is on the server and in every tab, as the last link of
// its document; a deleted keyring leaves each device's copy with all it
// was promised; and no request ever reached the gateway with another
// account's token (TR7).
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc } from "loro-crdt";
import { describe, expect, test, vi } from "vitest";
import {
  type KeyringTransport,
  bytesToBase64Url,
  decryptKeyring,
  httpAccountKeyringTransport,
  listKeyring,
  newKeyringDoc,
  newKeyringSecrets,
  readKeyringPlaintext,
  rememberLink,
} from "../../lib/src/index.js";
import { testLink } from "../../lib/src/keyring/test-support/links.js";
import { cryptoGate } from "../../lib/src/transport/test-support/crypto-gate.js";
import { eventually } from "../../lib/src/transport/test-support/eventually.js";
import { accountToken } from "./environment.js";
import type { KeyringLocal, StoredKeyring } from "./local.js";
import type { AccountLocal, SignedIn } from "./local.js";
import { type KeyringRef, isAccountKeyring, sameKeyring } from "./ref.js";
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

const KEY = bytesToBase64Url(new Uint8Array(32).fill(0xa0));
const link = (doc: string, generation: number) =>
  testLink(doc, "edit", generation);

/** A server of one keyring (KR-6, KR-7, KR-10): each request waits for the
 * test; a device offline is refused at once. */
class Server {
  version = 0;
  blob: Uint8Array = new Uint8Array(0);
  deleted = false;
  offline = new Set<number>();
  pending: { label: string; run: () => void }[] = [];

  transport(device: number): KeyringTransport {
    const later = <T>(label: string, take: () => T) => {
      if (this.offline.has(device)) return Promise.reject(new Error("offline"));
      return new Promise<T>((resolve) =>
        this.pending.push({ label, run: () => resolve(take()) }),
      );
    };
    return {
      read: () =>
        later("read", () =>
          this.deleted ? "missing" : { version: this.version, blob: this.blob },
        ),
      write: (version, blob) =>
        later("write", () => {
          if (this.deleted) return "missing" as const;
          if (version !== this.version) return { stale: this.version };
          this.version += 1;
          this.blob = blob;
          return { written: this.version };
        }),
    };
  }
}

/** The gateway's answers to `/accounts/keyring` (KR-39) for `server`'s
 * keyring, the account `u-1`'s: each request waits for the test, its token
 * checked when the test lets it through. A token of another account is a
 * fault of the page (TR7): noted, and refused. */
class Gateway {
  /** By token: its account. */
  readonly tokens = new Map<string, string>();
  readonly otherAccount: string[] = [];
  private next = 0;

  constructor(private readonly server: Server) {}

  tokenOf(sub: string): string {
    this.next += 1;
    const token = bytesToBase64Url(new Uint8Array(32).fill(this.next));
    this.tokens.set(token, sub);
    return token;
  }

  fetchFor(device: number) {
    return (_url: string, init?: RequestInit): Promise<Response> => {
      if (this.server.offline.has(device)) {
        return Promise.reject(new TypeError("offline"));
      }
      const headers = new Headers(init?.headers);
      const token = headers.get("authorization")?.replace(/^Bearer /, "");
      const method = init?.method ?? "GET";
      return new Promise((resolve) =>
        this.server.pending.push({
          label: method,
          run: () => resolve(this.answer(token, method, headers, init?.body)),
        }),
      );
    };
  }

  private answer(
    token: string | undefined,
    method: string,
    headers: Headers,
    body: unknown,
  ): Response {
    const sub = token === undefined ? undefined : this.tokens.get(token);
    if (sub !== undefined && sub !== "u-1") this.otherAccount.push(method);
    if (sub !== "u-1") return response(401);
    const server = this.server;
    if (method === "GET") return response(200, server.version, server.blob);
    if (headers.get("if-match") !== `"${server.version}"`) {
      return response(412, server.version);
    }
    server.version += 1;
    server.blob = body as Uint8Array;
    return response(204, server.version);
  }
}

/** As much of a `Response` as the transport reads: a real one's body ends
 * when the runtime says, not the test. */
function response(status: number, version?: number, blob?: Uint8Array) {
  return {
    status,
    headers: {
      get: (name: string) =>
        name === "etag" && version !== undefined ? `"${version}"` : null,
    },
    arrayBuffer: async () => (blob ?? new Uint8Array()).slice().buffer,
  } as unknown as Response;
}

/** A device's copy (local.ts's contract, in memory): writes one at a time
 * (the lock), each ending when the test says — or never, if its tab is
 * reloaded first and the test says it didn't land. */
class DeviceCopy {
  stored: { ref: KeyringRef; snapshot: Uint8Array } | undefined;
  pending: { tab: number; land: () => void; drop: () => void }[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  /** Tabs reloaded: a page gone runs nothing more, its writes waiting for
   * the lock included (only one already begun may still land). */
  private readonly gone = new Set<object>();

  /** The tab's page went: what it queued never runs. */
  reloaded(page: object): void {
    this.gone.add(page);
  }

  forTab(tab: number, page: object = {}): KeyringLocal {
    const turn = <T>(work: () => T | "skip") => {
      const run = this.tail.then(
        () =>
          new Promise<T>((resolve, reject) => {
            if (this.gone.has(page)) {
              reject(new Error("the tab was reloaded"));
              return;
            }
            this.pending.push({
              tab,
              land: () => {
                const done = work();
                if (done === "skip") reject(new Error("dropped"));
                else resolve(done);
              },
              drop: () => reject(new Error("dropped: the tab was reloaded")),
            });
          }),
      );
      this.tail = run.catch(() => {});
      return run;
    };
    return {
      load: async (): Promise<StoredKeyring | undefined> => {
        if (!this.stored) return undefined;
        const doc = new LoroDoc();
        doc.import(this.stored.snapshot);
        return { ref: this.stored.ref, doc };
      },
      save: (ref, doc) =>
        turn(() => {
          if (this.stored && !sameKeyring(this.stored.ref, ref))
            return "superseded" as const;
          if (this.stored) doc.import(this.stored.snapshot);
          this.stored = {
            ref,
            snapshot: doc.export({ mode: "snapshot" }),
          };
          return "saved" as const;
        }),
      replace: (ref, doc) =>
        turn(() => {
          this.stored = {
            ref,
            snapshot: doc.export({ mode: "snapshot" }),
          };
        }),
      claim: (ref, doc) =>
        turn(() => {
          if (this.stored && !sameKeyring(this.stored.ref, ref)) {
            return "taken" as const;
          }
          this.stored = {
            ref,
            snapshot: doc.export({ mode: "snapshot" }),
          };
          return "claimed" as const;
        }),
      join: (ref, doc, options) =>
        turn(() => {
          const here = this.stored;
          if (here && !sameKeyring(here.ref, ref) && !options?.merge)
            return "other" as const;
          if (here) doc.import(here.snapshot);
          this.stored = {
            ref,
            snapshot: doc.export({ mode: "snapshot" }),
          };
          if (!here) return "nothing-here" as const;
          return sameKeyring(here.ref, ref)
            ? ("same" as const)
            : ("merged" as const);
        }),
      forget: (ref) =>
        turn(() => {
          if (this.stored && sameKeyring(this.stored.ref, ref))
            this.stored = undefined;
        }),
      // The scenario never changes the key (18e has its own tests).
      rotate: async () => {
        throw new Error("not in this scenario");
      },
      retired: async () => [],
      clearRetired: async () => {},
      // No change of key here: no list replaced.
      successor: async () => undefined,
      // Starting over has its own scenario (start-over.property.test.ts).
      startOver: async () => "taken" as const,
      startingOver: async () => false,
      clearStartOver: async () => {},
    };
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** The generation a test link was written with (`testLink`'s secret). */
function generationOf(link: string): number {
  const secret = Buffer.from(link.split(".").pop() as string, "base64url");
  return Number(secret.toString("latin1").replace(/Z+$/, "").split("|")[2]);
}

const GATEWAY = "https://accounts.example";

/** `sub` signed in, with a token the gateway knows. */
function signedInAs(gateway: Gateway, sub: string): SignedIn {
  return {
    gateway: GATEWAY,
    token: gateway.tokenOf(sub),
    deadline: Number.MAX_SAFE_INTEGER,
    name: sub,
    email: null,
    issuer: "https://idp.example",
    sub,
  };
}

describe("the keyring across tabs and devices", () => {
  test(
    "whatever the order, every write promised ends on the server and in every tab",
    () =>
      hegel.testAsync(
        async (tc: TC) => {
          cryptoGate.start();
          try {
            // A keyring link's, or an account's (analysis 18i.3).
            const byAccount = tc.draw(gs.booleans());
            const credentials: KeyringRef = byAccount
              ? {
                  gateway: GATEWAY,
                  issuer: "https://idp.example",
                  sub: "u-1",
                  key: newKeyringSecrets().key,
                }
              : { keyringId: "ab".repeat(16), ...newKeyringSecrets() };
            const server = new Server();
            const gateway = new Gateway(server);
            /** Each device's account signed in: its token and account. */
            const signedIn: (SignedIn | undefined)[] = [0, 1].map(() =>
              signedInAs(gateway, "u-1"),
            );
            const accountLocal = (device: number): AccountLocal => ({
              signedIn: async () => signedIn[device],
              keepSignedIn: async () => {},
              forgetSignedIn: async () => {},
              associationLater: async () => false,
              keepAssociationLater: async () => {},
              identityName: async () => undefined,
              keepIdentityName: async () => {},
              attestation: async () => undefined,
              keepAttestation: async () => {},
              refusedKey: async () => undefined,
              keepRefusedKey: async () => {},
            });
            const copies = [new DeviceCopy(), new DeviceCopy()];
            const TABS = [0, 0, 1]; // the device of each tab
            const timers: { tab: number; run: () => void; live: boolean }[] =
              [];
            // Each page of each tab: replaced at a reload.
            const pages = TABS.map(() => ({}));
            const options = (tab: number): KeyringSessionOptions => {
              const device = TABS[tab] as number;
              return {
                remove: async () => "deleted",
                local: (copies[device] as DeviceCopy).forTab(
                  tab,
                  pages[tab] as object,
                ),
                transport: (ref) =>
                  isAccountKeyring(ref)
                    ? httpAccountKeyringTransport(
                        GATEWAY,
                        () => accountToken(accountLocal(device), ref),
                        gateway.fetchFor(device),
                      )
                    : server.transport(device),
                setTimer: (run) => {
                  const timer = { tab, run, live: true };
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
            // Device 0 holds the keyring; device 1 gets it pasted (the same
            // credentials, an empty copy). Both copies stored at once.
            for (const device of [0, 1]) {
              (copies[device] as DeviceCopy).stored = {
                ref: credentials,
                snapshot: newKeyringDoc().export({ mode: "snapshot" }),
              };
            }
            const sessions: (KeyringSession | undefined)[] = [];
            for (const tab of TABS.keys())
              sessions[tab] = await KeyringSession.open(options(tab));
            // Per tab: its documents' last promised link, and what's next.
            const promised = TABS.map(() => new Map<string, string>());
            const generation = TABS.map(() => new Map<string, number>());
            let deleted = false;
            // The wall clock of every tab: later at each write.
            let clock = 0;

            for (
              let step = tc.draw(gs.integers({ minValue: 1, maxValue: 40 }));
              step > 0;
              step--
            ) {
              const moves: string[] = [
                "write",
                "write",
                "reload",
                "pair",
                "offline",
              ];
              if (server.pending.length > 0)
                moves.push("serve", "serve", "serve");
              if (copies.some((c) => c.pending.length > 0))
                moves.push("land", "land", "land");
              if (cryptoGate.held.length > 0)
                moves.push("crypto", "crypto", "crypto");
              if (timers.some((t) => t.live)) moves.push("timer", "timer");
              if (!deleted && !byAccount) moves.push("delete");
              if (byAccount)
                moves.push("expire", "sign-out", "other", "sign-in");
              const move = tc.draw(gs.sampledFrom(moves));
              const tab = tc.draw(
                gs.integers({ minValue: 0, maxValue: TABS.length - 1 }),
              );
              const session = sessions[tab];
              if (move === "write" && session) {
                // A new document, or a rotation of one of the tab's own.
                const own = [...(generation[tab]?.keys() ?? [])];
                const doc =
                  own.length > 0 && tc.draw(gs.booleans())
                    ? tc.draw(gs.sampledFrom(own))
                    : `t${tab}-${own.length}`;
                const g = (generation[tab]?.get(doc) ?? -1) + 1;
                generation[tab]?.set(doc, g);
                const written = link(doc, g);
                session
                  .change((d) => void rememberLink(d, written, { at: ++clock }))
                  .then(
                    (outcome) => {
                      if (outcome === "saved") promised[tab]?.set(doc, written);
                    },
                    () => {},
                  );
              } else if (move === "reload" || move === "pair") {
                session?.close();
                sessions[tab] = undefined;
                const device = TABS[tab] as number;
                const copy = copies[device] as DeviceCopy;
                copy.reloaded(pages[tab] as object);
                pages[tab] = {};
                for (const write of copy.pending.filter((p) => p.tab === tab)) {
                  copy.pending.splice(copy.pending.indexOf(write), 1);
                  if (tc.draw(gs.booleans())) write.land();
                  else write.drop();
                }
                await settle();
                if (move === "reload") {
                  sessions[tab] = await KeyringSession.open(options(tab));
                } else {
                  // The join waits for its turn in the copy: the test
                  // lands it, later. Until then the tab has no list.
                  const page = pages[tab];
                  KeyringSession.join(options(tab), credentials).then(
                    ({ session: joined }) => {
                      if (pages[tab] === page) sessions[tab] = joined;
                      else joined?.close();
                    },
                    () => {},
                  );
                }
              } else if (move === "offline") {
                const device = TABS[tab] as number;
                if (server.offline.has(device)) server.offline.delete(device);
                else server.offline.add(device);
              } else if (move === "serve") {
                const i = tc.draw(
                  gs.integers({
                    minValue: 0,
                    maxValue: server.pending.length - 1,
                  }),
                );
                server.pending.splice(i, 1)[0]?.run();
              } else if (move === "land") {
                const copy = tc.draw(
                  gs.sampledFrom(copies.filter((c) => c.pending.length > 0)),
                );
                copy.pending.shift()?.land();
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
                const live = timers.filter((t) => t.live);
                const timer = tc.draw(gs.sampledFrom(live));
                timer.live = false;
                timer.run();
              } else if (move === "expire") {
                // The gateway's clock: the device's token no longer opens.
                gateway.tokens.delete(
                  signedIn[TABS[tab] as number]?.token ?? "",
                );
              } else if (move === "sign-out") {
                signedIn[TABS[tab] as number] = undefined;
              } else if (move === "other") {
                // Another person signs in on this device (case 4, TR7).
                signedIn[TABS[tab] as number] = signedInAs(gateway, "u-2");
              } else if (move === "sign-in") {
                const device = TABS[tab] as number;
                signedIn[device] = signedInAs(gateway, "u-1");
                // As the home does when the account signs in (TR6).
                for (const [t, d] of TABS.entries())
                  if (d === device) void sessions[t]?.sync();
              } else if (
                move === "delete" &&
                tc.draw(gs.integers({ minValue: 0, maxValue: 5 })) === 0
              ) {
                deleted = true;
                server.deleted = true;
              }
              await settle();
            }

            // The end: online, everything let through, then each tab syncs
            // until nothing is left to do, twice round.
            // The gate stays on, released in order: stopped, it would no
            // longer count the work in progress, and `settle` would return
            // while some still runs.
            server.offline.clear();
            for (const device of [0, 1]) {
              signedIn[device] = signedInAs(gateway, "u-1");
            }
            const drain = async () => {
              for (let i = 0; i < 10_000; i++) {
                await settle();
                const held = cryptoGate.held[0];
                if (held) {
                  cryptoGate.release(held);
                  continue;
                }
                const write = copies
                  .find((c) => c.pending.length > 0)
                  ?.pending.shift();
                if (write) {
                  write.land();
                  continue;
                }
                const request = server.pending.shift();
                if (request) {
                  request.run();
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
            await drain();
            for (let round = 0; round < 2; round++) {
              for (const session of sessions) {
                const status = session?.sync();
                await drain();
                const outcome = await status;
                expect(outcome).toBe(deleted ? "missing" : "synced");
              }
            }

            // TR7: never another account's token for this list.
            expect(gateway.otherAccount).toEqual([]);
            // Nothing runs any more: the checks' own decryption passes.
            cryptoGate.stop();
            const expected = new Map(promised.flatMap((m) => [...m]));
            const listed = (doc: LoroDoc) =>
              new Map(listKeyring(doc).map((e) => [e.documentId, e.link]));
            const sees = (doc: LoroDoc) => {
              const has = listed(doc);
              for (const [doc, link] of expected) {
                // A later link of the same document, written but not yet
                // promised when its tab was reloaded, may have won: never
                // an older one.
                const shown = has.get(doc);
                expect(shown, doc).toBeDefined();
                expect(
                  generationOf(shown as string),
                  doc,
                ).toBeGreaterThanOrEqual(generationOf(link));
              }
            };
            if (!deleted) {
              sees(
                readKeyringPlaintext(
                  await decryptKeyring(credentials.key, server.blob),
                ) as LoroDoc,
              );
              for (const session of sessions) if (session) sees(session.doc);
            } else {
              for (const copy of copies) {
                const doc = new LoroDoc();
                if (copy.stored) doc.import(copy.stored.snapshot);
                // Each device keeps what its own tabs were promised.
                const has = listed(doc);
                for (const [tab, mine] of promised.entries()) {
                  if (copies[TABS[tab] as number] !== copy) continue;
                  for (const doc of mine.keys())
                    expect(has.has(doc), doc).toBe(true);
                }
              }
            }
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
