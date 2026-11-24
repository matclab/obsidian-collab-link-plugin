// @vitest-environment jsdom
//
// Analysis 30 (docs/phase-30-nouvelle-cle-de-signature.md) under an order
// the test draws (AGENTS.md §1.6): the account's list holds a revoked key
// (UK6), a second key registered at the gateway; two devices — A with two
// holders sharing its copy and lock, B with one — click « Nouvelle clé de
// signature », ask their attestation, sign, sign in recently, read the
// revocation list, and B reloads its page at any time. The choices: which
// answer of the list's server or of the gateway is delivered, or fails;
// which write of a device's copy goes next (the lock then orders them);
// a composed gesture, two clicks in the same round trip (case 3).
// At every step: NK-I1, a key in the list is written only over a key
// refused by then; NK-I3, a key registered was at the list's server
// before. At the end, everything delivered, signed in recently, the list
// read, and the gesture made wherever a refusal is still said: one key on
// every holder, the gateway's, not revoked, attested (NK-I4); every key a
// live page signed with in `keys` (NK-I2).
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { IDBFactory } from "fake-indexeddb";
import type { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import {
  type RevocationList,
  decryptKeyring,
  encryptKeyring,
  exportPrivateKey,
  fingerprintOf,
  generateIdentityKey,
  keyringIdentity,
  newKeyringDoc,
  newKeyringSecrets,
  ownKeys,
  readKeyringPlaintext,
  setKeyringIdentity,
} from "../../lib/src/index.js";
import { type IdentityKeys, identityKeys } from "../identity/identity-keys.js";
import {
  type KeyringLocal,
  type KeyringLock,
  openKeyringLocal,
} from "../keyring/local.js";
import type { AccountKeyring } from "../keyring/ref.js";
import { KEYRING_SYNC_DELAY_MS, KeyringSession } from "../keyring/session.js";
import { Attestor, type AttestorState } from "./attestor.js";
import { memoryAccountLocal } from "./test-support.js";
import { KeysGateway } from "./test-support/keys-gateway.js";

type TC = Parameters<Parameters<typeof hegel.testAsync>[0]>[0];
const GATEWAY = "https://accounts.example";
const ACCOUNT = { gateway: GATEWAY, issuer: "https://idp.example", sub: "u-1" };
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const IDENTITY = "cid:root-identity:Map";

function memoryLock(): KeyringLock {
  const tails = new Map<string, Promise<unknown>>();
  return {
    exclusive(name, run) {
      const result = (tails.get(name) ?? Promise.resolve()).then(run, run);
      tails.set(
        name,
        result.catch(() => {}),
      );
      return result;
    },
  };
}

interface Pending {
  holder: Holder;
  /** The order of its holder's opening: one pending per holder, its
   * place in the list never the order in which holders reached it. */
  order: number;
  label: string;
  /** A network answer may fail (offline); a write of the copy doesn't. */
  failable: boolean;
  go(ok: boolean): void;
}

interface Holder {
  device: Device;
  session: KeyringSession;
  keys: IdentityKeys;
  attestor: Attestor;
  task: Promise<void> | undefined;
  /** Its answers and writes held by the test. */
  waiting: number;
  last: AttestorState | undefined;
  /** The keys this page signed with. */
  signed: Set<string>;
  /** Its page reloaded: what it held is dropped. */
  gone: boolean;
}

interface Device {
  name: string;
  local: KeyringLocal;
  account: ReturnType<typeof memoryAccountLocal>;
  token: string;
}

/** The identity key before each write of it in `doc`, by its op's id. */
function identityWrites(doc: LoroDoc): Map<string, Uint8Array | null> {
  const json = doc.exportJsonUpdates();
  const writes = new Map<string, Uint8Array | null>();
  for (const change of json.changes) {
    const [first, index] = change.id.split("@");
    const peer = json.peers[Number(index)] as string;
    const start = Number(first);
    for (const op of change.ops) {
      if (op.container !== IDENTITY) continue;
      const deps =
        op.counter > start
          ? [{ peer: peer as `${number}`, counter: op.counter - 1 }]
          : change.deps.map((dep) => {
              const [counter, at] = dep.split("@");
              return {
                peer: json.peers[Number(at)] as `${number}`,
                counter: Number(counter),
              };
            });
      const before = doc.forkAt(deps);
      writes.set(
        `${peer}:${op.counter}`,
        keyringIdentity(before)?.publicKey ?? null,
      );
    }
  }
  return writes;
}

describe("a refused key replaced, in any order (analysis 30)", () => {
  test(
    "NK-I1 – NK-I4",
    () =>
      hegel.testAsync(
        async (tc: TC) => {
          const gateway = await KeysGateway.create();
          const refused = await generateIdentityKey({ extractable: true });
          const other = await generateIdentityKey();
          // UK6: the list kept the key that the other's registration revoked.
          gateway.accounts.set("u-1", { ...ACCOUNT, key: other.publicKey });
          gateway.revoked.add(hex(refused.publicKey));
          const ref: AccountKeyring = {
            ...ACCOUNT,
            key: newKeyringSecrets().key,
          };
          const start = newKeyringDoc();
          // Loro orders two concurrent writes by their peers: fixed, so that
          // a case replays (AGENTS.md §1.4).
          start.setPeerId(1n);
          setKeyringIdentity(
            start,
            await exportPrivateKey(refused.privateKey),
            refused.publicKey,
          );
          const server = {
            version: 1,
            blob: await encryptKeyring(
              ref.key,
              start.export({ mode: "snapshot" }),
            ),
          };
          /** Every blob the list's server held, in order (NK-I3). */
          const blobs = [server.blob];
          /** Each registration, and how many blobs the server had held by
           * then. */
          const registrations: { key: string; held: number }[] = [];
          let list: RevocationList | undefined;
          const readRevocations = () => {
            list = {
              issuedAt: (list?.issuedAt ?? 0) + 1,
              revoked: new Map(
                [...gateway.revoked].map((key) => [
                  hex(fingerprintOf(Uint8Array.from(Buffer.from(key, "hex")))),
                  1,
                ]),
              ),
            };
          };

          const pending: Pending[] = [];
          const failures: unknown[] = [];
          let wake = () => {};
          const holders: Holder[] = [];

          const device = async (name: string): Promise<Device> => {
            const local = openKeyringLocal({
              indexedDB: new IDBFactory(),
              lock: memoryLock(),
            });
            const copy = newKeyringDoc();
            copy.import(start.export({ mode: "snapshot" }));
            await local.claim(ref, copy);
            const account = memoryAccountLocal();
            const token = `T-${name}`;
            gateway.token(token, "u-1", false);
            account.stored = {
              gateway: GATEWAY,
              token,
              deadline: gateway.now + 12 * 3600_000,
              name: "u-1",
              email: null,
              issuer: ACCOUNT.issuer,
              sub: ACCOUNT.sub,
            };
            return { name, local, account, token };
          };
          const signInRecently = (at: Device) => {
            gateway.token(at.token, "u-1", true);
            if (at.account.stored) {
              at.account.stored = {
                ...at.account.stored,
                recentUntil: gateway.now + 600_000,
              };
            }
          };

          const open = async (at: Device): Promise<Holder> => {
            const holder = {
              device: at,
              task: undefined,
              waiting: 0,
              last: undefined,
              signed: new Set<string>(),
              gone: false,
            } as unknown as Holder;
            /** `run` once the test delivers it; rejected if it fails. */
            const held = <T>(
              label: string,
              failable: boolean,
              run: () => Promise<T>,
            ) =>
              new Promise<T>((resolve, reject) => {
                holder.waiting += 1;
                pending.push({
                  holder,
                  order: holders.indexOf(holder),
                  label,
                  failable,
                  go: (ok) => {
                    holder.waiting -= 1;
                    if (!ok) reject(new TypeError("network"));
                    else run().then(resolve, reject);
                  },
                });
                wake();
              });
            const local: KeyringLocal = {
              ...at.local,
              save: (r, doc, edit) =>
                held("save", false, () => at.local.save(r, doc, edit)),
            };
            const session = await KeyringSession.open({
              local,
              transport: () => ({
                read: () =>
                  held("read", true, async () => ({
                    version: server.version,
                    blob: server.blob,
                  })),
                write: (version, blob) =>
                  held("write", true, async () => {
                    if (version !== server.version) {
                      return { stale: server.version };
                    }
                    server.version = version + 1;
                    server.blob = blob;
                    blobs.push(blob);
                    return { written: server.version };
                  }),
              }),
              remove: async () => "missing",
              // The session's own syncs are the test's tasks; the wait after a
              // `412` goes at once.
              setTimer: (run, ms) => {
                if (ms > 0 && ms < KEYRING_SYNC_DELAY_MS) queueMicrotask(run);
                return () => {};
              },
            });
            if (!session) throw new Error("no list stored");
            session.doc.setPeerId(BigInt(holders.length + 2));
            const keys = identityKeys({
              keyring: async () => session,
              now: () => gateway.now,
            });
            const attestor = await Attestor.open({
              gateway: GATEWAY,
              configured: new Set([gateway.fingerprint]),
              local: at.account,
              revocations: { current: () => list },
              fetch: (url, init) => {
                const path = new URL(url).pathname;
                return held(path, true, async () => {
                  if (path === "/accounts/key") {
                    const body = JSON.parse(String(init?.body)) as {
                      key: string;
                    };
                    registrations.push({
                      key: hex(Buffer.from(body.key, "base64url")),
                      held: blobs.length,
                    });
                  }
                  return gateway.fetch(url, init);
                });
              },
              now: () => gateway.now,
              setTimer: () => () => {},
              accountSigner: (account) => keys.accountSigner(account),
              registrable: (account, key) => keys.registrable(account, key),
            });
            Object.assign(holder, { session, keys, attestor });
            holders.push(holder);
            return holder;
          };

          const run = (holder: Holder, work: () => Promise<void>) => {
            if (holder.task || holder.gone) return;
            holder.task = work()
              .catch((error) => {
                if (!(error instanceof TypeError)) failures.push(error);
              })
              .finally(() => {
                holder.task = undefined;
                wake();
              });
          };
          const refresh = (holder: Holder) =>
            run(holder, async () => {
              holder.last = await holder.attestor.refresh();
            });
          const click = (holder: Holder) =>
            run(holder, async () => {
              const key = holder.attestor.refusedKey();
              if (!key) return;
              await holder.keys.replaceRefused(ACCOUNT, key);
              holder.last = await holder.attestor.refresh();
            });
          const sign = (holder: Holder) =>
            run(holder, async () => {
              const signer = await holder.keys.signer();
              if (signer) holder.signed.add(hex(signer.publicKey));
            });
          const sync = (holder: Holder) =>
            run(holder, async () => {
              await holder.session.sync();
            });

          /** Until every live holder is idle, or waits on the test only:
           * nothing in progress outside its control (counters, not rounds). */
          const settle = async () => {
            for (;;) {
              const busy = holders.some(
                (h) => !h.gone && h.task !== undefined && h.waiting === 0,
              );
              if (!busy) {
                pending.sort((x, y) => x.order - y.order);
                return;
              }
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
            }
          };
          const seen = new Set<string>();
          /** The key of each blob the server held, decrypted once. */
          const keysAtServer: (string | undefined)[] = [];
          const invariants = async () => {
            expect(failures.map(String), "a task failed").toEqual([]);
            const atServer = readKeyringPlaintext(
              await decryptKeyring(ref.key, server.blob),
            ) as LoroDoc;
            for (let i = keysAtServer.length; i < blobs.length; i++) {
              const doc = readKeyringPlaintext(
                await decryptKeyring(ref.key, blobs[i] as Uint8Array),
              ) as LoroDoc;
              const key = keyringIdentity(doc)?.publicKey;
              keysAtServer.push(key && hex(key));
            }
            // NK-I3: a key registered was at the list's server before.
            for (const { key, held } of registrations.splice(0)) {
              expect(
                keysAtServer.slice(0, held).includes(key),
                `NK-I3: ${key} registered, never at the server before`,
              ).toBe(true);
            }
            // NK-I1: every new write of the key, over a key refused by now.
            for (const doc of [
              atServer,
              ...holders.map((h) => h.session.doc),
            ]) {
              for (const [id, before] of identityWrites(doc)) {
                if (seen.has(id)) continue;
                seen.add(id);
                expect(
                  before === null || gateway.revoked.has(hex(before)),
                  `NK-I1: written over ${before && hex(before)}, not refused`,
                ).toBe(true);
              }
            }
          };
          /** Everything delivered, in order. */
          const drain = async () => {
            for (;;) {
              await settle();
              const next = pending.shift();
              if (!next) {
                if (holders.every((h) => h.gone || !h.task)) return;
                continue;
              }
              next.go(true);
            }
          };

          const a = await device("A");
          const b = await device("B");
          await open(a);
          await open(a);
          await open(b);
          const live = () => holders.filter((h) => !h.gone);
          const pick = () =>
            tc.draw(gs.sampledFrom(live().map((_, i) => i))) as number;
          if (tc.draw(gs.booleans())) readRevocations();
          for (const h of live()) refresh(h);
          await settle();
          await invariants();

          for (
            let step = tc.draw(gs.integers({ minValue: 1, maxValue: 40 }));
            step > 0;
            step--
          ) {
            const choice = tc.draw(gs.integers({ minValue: 0, maxValue: 11 }));
            if (choice <= 4) {
              if (pending.length === 0) continue;
              const at = tc.draw(
                gs.integers({ minValue: 0, maxValue: pending.length - 1 }),
              );
              const [next] = pending.splice(at, 1);
              const ok =
                !next?.failable ||
                tc.draw(gs.integers({ minValue: 0, maxValue: 5 })) > 0;
              next?.go(ok);
            } else {
              const holder = live()[pick()] as Holder;
              switch (choice) {
                case 5:
                  click(holder);
                  break;
                case 6:
                  refresh(holder);
                  break;
                case 7:
                  sign(holder);
                  break;
                case 8:
                  signInRecently(holder.device);
                  break;
                case 9:
                  readRevocations();
                  break;
                case 10: {
                  // B's page reloaded: what it held but hadn't done is lost.
                  const old = live().find((h) => h.device === b) as Holder;
                  old.gone = true;
                  for (let i = pending.length - 1; i >= 0; i--) {
                    if (pending[i]?.holder === old) pending.splice(i, 1);
                  }
                  await open(b);
                  break;
                }
                case 11: {
                  // Case 3: a click on each device in the same round trip.
                  signInRecently(a);
                  signInRecently(b);
                  for (const h of live()) {
                    if (h.device === b || h === live()[0]) click(h);
                  }
                  break;
                }
              }
            }
            await settle();
            await invariants();
          }

          // The end: delivered, signed in recently, the list read, and the
          // gesture wherever a refusal is still said.
          await drain();
          signInRecently(a);
          signInRecently(b);
          for (let round = 0; round < 4; round++) {
            readRevocations();
            for (const h of live()) {
              run(h, async () => {
                await h.session.sync();
                h.last = await h.attestor.refresh();
                const key = h.attestor.refusedKey();
                if (h.last === "refused" && key) {
                  await h.keys.replaceRefused(ACCOUNT, key);
                  h.last = await h.attestor.refresh();
                }
              });
              await drain();
              await invariants();
            }
          }
          for (const h of live()) {
            sign(h);
            await drain();
            sync(h);
            await drain();
          }
          for (const h of live()) {
            sync(h);
            await drain();
          }
          await invariants();
          const registered = gateway.accounts.get("u-1")?.key as Uint8Array;
          expect(gateway.revoked.has(hex(registered)), "NK-I4: revoked").toBe(
            false,
          );
          const atServer = readKeyringPlaintext(
            await decryptKeyring(ref.key, server.blob),
          ) as LoroDoc;
          const mine = new Set(ownKeys(atServer).map(hex));
          for (const h of live()) {
            const key = keyringIdentity(h.session.doc)?.publicKey as Uint8Array;
            expect(hex(key), "one key, the gateway's").toBe(hex(registered));
            expect(h.last, "NK-I4: attested").toBe("attested");
            expect(
              h.attestor.envelopeFor(key),
              "NK-I4: held for its key",
            ).toBeInstanceOf(Uint8Array);
            for (const used of h.signed) {
              if (used === hex(key)) continue;
              expect(mine.has(used), `NK-I2: ${used} in keys`).toBe(true);
            }
          }
        },
        { testCases: Number(process.env.NK_CASES ?? 100) },
      ),
    600_000,
  );
});
