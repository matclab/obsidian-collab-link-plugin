// @vitest-environment node
//
// Two devices attach their lists to one empty account at once, each under
// its own key (docs/phase-18-trousseau-identite.md, analyses 18i and 18i.3,
// case 2; KR-44). Every source of order is a choice of the test: when the
// gateway takes each request, when each encryption and decryption ends
// (`cryptoGate`), when each wait after a `412` ends. Then:
// - exactly one list is the account's; the other device wrote nothing
//   there, says `unreadable`, and keeps its copy and its keyring (not
//   deleted);
// - the winner's old keyring is deleted, once its write was accepted;
// - the account's key pasted on the other device, its copy merges in: the
//   account holds both lists, and its old keyring goes too.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { LoroDoc } from "loro-crdt";
import { describe, expect, test, vi } from "vitest";
import {
  type KeyringCredentials,
  createKeyring,
  decryptKeyring,
  deleteKeyring,
  formatKeyringLink,
  httpAccountKeyringTransport,
  httpKeyringTransport,
  listKeyring,
  newKeyringDoc,
  readKeyringPlaintext,
  rememberLink,
} from "../../lib/src/index.js";
import { FakeKeyringServer } from "../../lib/src/keyring/test-support/fake-keyring-server.js";
import { testLink } from "../../lib/src/keyring/test-support/links.js";
import { cryptoGate } from "../../lib/src/transport/test-support/crypto-gate.js";
import { eventually } from "../../lib/src/transport/test-support/eventually.js";
import type { KeyringLocal } from "./local.js";
import {
  type AccountKeyring,
  type KeyringRef,
  formatKeyringRef,
  isAccountKeyring,
} from "./ref.js";
import { KeyringSession, type KeyringStatus } from "./session.js";

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

const ORIGIN = "https://collab.test";
const GATEWAY = "https://accounts.example";
const TOKEN = `${"T".repeat(42)}A`;

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** As much of a `Response` as the transport reads. */
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

/** The account's keyring at the gateway (KR-39), each request waiting for
 * the test. */
class Gateway {
  version = 0;
  blob: Uint8Array = new Uint8Array();
  pending: (() => void)[] = [];

  fetch = (_url: string, init?: RequestInit): Promise<Response> =>
    new Promise((resolve) => {
      this.pending.push(() => {
        const headers = new Headers(init?.headers);
        if (headers.get("authorization") !== `Bearer ${TOKEN}`) {
          resolve(response(401));
        } else if ((init?.method ?? "GET") === "GET") {
          resolve(response(200, this.version, this.blob));
        } else if (headers.get("if-match") !== `"${this.version}"`) {
          resolve(response(412, this.version));
        } else {
          this.version += 1;
          this.blob = init?.body as Uint8Array;
          resolve(response(204, this.version));
        }
      });
    });
}

/** A device's keyring record, in memory, as `local.ts` keeps it. */
function memoryLocal(): KeyringLocal & {
  stored: () => { ref: string; doc: LoroDoc } | undefined;
} {
  let ref: string | undefined;
  let doc: LoroDoc | undefined;
  let retired: KeyringCredentials[] = [];
  const keep = (next: KeyringRef, copy: LoroDoc) => {
    ref = formatKeyringRef(next);
    doc = copy;
  };
  return {
    stored: () => (ref && doc ? { ref, doc } : undefined),
    load: async () => undefined,
    save: async (next, copy) => {
      if (ref !== undefined && ref !== formatKeyringRef(next))
        return "superseded";
      keep(next, copy);
      return "saved";
    },
    replace: async (next, copy) => keep(next, copy),
    claim: async (next, copy) => {
      keep(next, copy);
      return "claimed";
    },
    join: async () => "nothing-here",
    forget: async () => {},
    rotate: async (next, copy, old) => {
      keep(next, copy);
      retired = [...retired, old];
      return "rotated";
    },
    retired: async () => retired,
    clearRetired: async (old) => {
      retired = retired.filter(
        (r) => formatKeyringLink(r) !== formatKeyringLink(old),
      );
    },
    // One session per device here: no tab left on a replaced list.
    successor: async () => undefined,
    // Starting over (analysis 18p.3) is not in this test.
    startOver: async () => "taken" as const,
    startingOver: async () => false,
    clearStartOver: async () => {},
  };
}

describe("two devices attach to one empty account at once (case 2)", () => {
  test(
    "one list wins, none is lost, both once the key is pasted",
    () =>
      hegel.testAsync(
        async (tc) => {
          cryptoGate.start();
          try {
            const server = new FakeKeyringServer();
            const gateway = new Gateway();
            const timers: (() => void)[] = [];
            const statuses: KeyringStatus[][] = [[], []];
            /** Deletions of old keyrings in progress. */
            let removing = 0;
            const locals = [memoryLocal(), memoryLocal()];
            const options = (device: number) => ({
              local: locals[device] as KeyringLocal,
              transport: (ref: KeyringRef) =>
                isAccountKeyring(ref)
                  ? httpAccountKeyringTransport(
                      GATEWAY,
                      async () => TOKEN,
                      gateway.fetch,
                    )
                  : httpKeyringTransport(ORIGIN, ref, server.fetch),
              // Counted until it ends: its secret's hash is WebCrypto's.
              remove: async (credentials: KeyringCredentials) => {
                removing += 1;
                try {
                  return await deleteKeyring(ORIGIN, credentials, server.fetch);
                } finally {
                  removing -= 1;
                }
              },
              setTimer: (run: () => void) => {
                timers.push(run);
                return () => {};
              },
              onStatus: (status: KeyringStatus) =>
                statuses[device]?.push(status),
            });
            /** Everything the test doesn't hold has ended. */
            const settle = async () => {
              do {
                await eventually(
                  () => cryptoGate.running === 0 && removing === 0,
                );
                await flush();
                await flush();
              } while (cryptoGate.running > 0 || removing > 0);
            };
            // Each device: a list by link, holding its own document.
            cryptoGate.stop();
            const links: KeyringCredentials[] = [];
            const sessions: KeyringSession[] = [];
            for (const device of [0, 1]) {
              const created = await createKeyring(ORIGIN, server.fetch);
              links.push(created);
              const doc = newKeyringDoc();
              rememberLink(doc, testLink(`d${device}`, "edit"), { at: 1 });
              sessions.push(
                (await KeyringSession.adopt(
                  options(device),
                  created,
                  doc,
                  true,
                )) as KeyringSession,
              );
            }
            for (const session of sessions) await session.sync();
            timers.length = 0;
            cryptoGate.start();
            // Both attach, each under its own key.
            const account = (key: Uint8Array): AccountKeyring => ({
              gateway: GATEWAY,
              issuer: "https://idp.example",
              sub: "u-1",
              key,
            });
            const attached = await Promise.all(
              sessions.map(async (s) => {
                const next = await KeyringSession.rotate(s, account(s.ref.key));
                if (!next) throw new Error("each device has its own copy");
                return next;
              }),
            );
            const outcomes = attached.map((s) => s.sync());
            // The test orders every request, every encryption, every wait.
            for (let i = 0; i < 400; i++) {
              await settle();
              const choices = [
                ...gateway.pending.map((_, at) => ({ kind: "gateway", at })),
                ...cryptoGate.held.map((_, at) => ({ kind: "crypto", at })),
                ...timers.map((_, at) => ({ kind: "timer", at })),
              ];
              if (choices.length === 0) break;
              const choice = tc.draw(gs.sampledFrom(choices));
              if (choice.kind === "gateway")
                gateway.pending.splice(choice.at, 1)[0]?.();
              else if (choice.kind === "crypto") {
                const held = cryptoGate.held[choice.at];
                if (held) cryptoGate.release(held);
              } else timers.splice(choice.at, 1)[0]?.();
            }
            const results = await Promise.all(outcomes);
            // The checks' own decryptions pass.
            cryptoGate.stop();
            // Exactly one is the account's; the other wrote nothing there.
            expect([...results].sort()).toEqual(["synced", "unreadable"]);
            const winner = results.indexOf("synced");
            const loser = 1 - winner;
            const read = async (key: Uint8Array) =>
              listKeyring(
                readKeyringPlaintext(
                  await decryptKeyring(key, gateway.blob),
                ) as LoroDoc,
              )
                .map((e) => e.documentId)
                .sort();
            const winnerKey = (attached[winner] as KeyringSession).ref.key;
            expect(await read(winnerKey)).toEqual([`d${winner}`]);
            // The winner's old keyring deleted; the loser's kept, as its copy.
            expect(
              server.keyrings.has(
                (links[winner] as KeyringCredentials).keyringId,
              ),
            ).toBe(false);
            expect(
              server.keyrings.has(
                (links[loser] as KeyringCredentials).keyringId,
              ),
            ).toBe(true);
            expect(
              listKeyring((attached[loser] as KeyringSession).doc).map(
                (e) => e.documentId,
              ),
            ).toContain(`d${loser}`);
            // The account's key pasted on the loser (KR-30): both lists.
            cryptoGate.start();
            const pasted = (await KeyringSession.adopt(
              options(loser),
              account(winnerKey),
              (attached[loser] as KeyringSession).doc,
              true,
            )) as KeyringSession;
            for (let round = 0; round < 3; round++) {
              let ended = false;
              const status = pasted.sync().finally(() => {
                ended = true;
              });
              for (let i = 0; !ended && i < 2000; i++) {
                await settle();
                const held = cryptoGate.held[0];
                const next =
                  gateway.pending.shift() ??
                  (held && (() => cryptoGate.release(held))) ??
                  timers.shift();
                if (!next) break;
                next();
              }
              await status;
            }
            cryptoGate.stop();
            expect(await read(winnerKey)).toEqual(["d0", "d1"]);
            expect(
              server.keyrings.has(
                (links[loser] as KeyringCredentials).keyringId,
              ),
            ).toBe(false);
            for (const session of [...attached, pasted]) session.close();
          } finally {
            cryptoGate.stop();
          }
        },
        { testCases: 100 },
      ),
    600_000,
  );
});
