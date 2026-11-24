import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
// @vitest-environment jsdom
//
// An address that names a document without its key (docs/phase-19-liens.md,
// decision 5, analysis 19b), in any order: whether this device's copy of
// « Mes documents » holds the document, whether the list's server does,
// whether each request to it is answered or fails as the network does,
// when it is taken, whether another tab adds the document, and when, and
// when each encryption and decryption of the list ends (`cryptoGate`:
// WebCrypto ends them in real time, outside the test's hands).
// The test takes every request. Whatever the order: the page opens only
// with a link of the document from the list; the address is that link,
// or the address it was; a document in this device's copy opens without
// the network; one the list's server holds, reachable, opens; one nowhere
// is said absent only once the list was checked.
import { IDBFactory } from "fake-indexeddb";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { bytesToBase64Url } from "../../lib/src/crypto/role-secrets.js";
import {
  CloseCode,
  ConnectionRefused,
  createKeyring,
  documentLinks,
  newKeyringDoc,
  rememberLink,
} from "../../lib/src/index.js";
import { FakeKeyringServer } from "../../lib/src/keyring/test-support/fake-keyring-server.js";
import { testLink } from "../../lib/src/keyring/test-support/links.js";
import { cryptoGate } from "../../lib/src/transport/test-support/crypto-gate.js";
import { t } from "../i18n/index.js";
import { sessionOptions } from "../keyring/environment.js";
import { openKeyringLocal } from "../keyring/local.js";
import { KeyringSession } from "../keyring/session.js";
import { type PageEnvironment, startPage } from "./page.js";

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

const ORIGIN = "https://collab.test";
const PAGE = `${ORIGIN}/`;
const ADDRESS = `${ORIGIN}/?doc=wanted#h=Partie%20un`;

const lock = {
  exclusive: <T>(_name: string, run: () => Promise<T>) => run(),
};

/** The page's own steps waiting for their turn: IndexedDB's
 * (`fake-indexeddb` takes one by `setImmediate`). Counted, so that `quiet`
 * waits for them all — the test's own turns don't count. */
const turn = globalThis.setImmediate;
let immediates = 0;
const tick = () => new Promise((resolve) => turn(resolve));

/** WebCrypto's work in progress, any of it — the role secrets', the
 * identity keys', the server's: counted, so that `quiet` waits for it
 * (it ends in real time). The list's own encryptions and decryptions are
 * held besides (`cryptoGate`), their end a choice. */
let subtleRunning = 0;
const SUBTLE = [
  "encrypt",
  "decrypt",
  "digest",
  "importKey",
  "exportKey",
  "deriveKey",
  "deriveBits",
  "sign",
  "verify",
  "generateKey",
  "wrapKey",
  "unwrapKey",
] as const;
const subtle = Object.getPrototypeOf(crypto.subtle) as Record<
  string,
  (...args: unknown[]) => Promise<unknown>
>;
const unpatched = new Map<string, (...args: unknown[]) => Promise<unknown>>();
beforeAll(() => {
  globalThis.setImmediate = ((run: (...args: unknown[]) => void, ...args) => {
    immediates += 1;
    return turn(() => {
      immediates -= 1;
      run(...args);
    });
  }) as typeof setImmediate;
  for (const name of SUBTLE) {
    const real = subtle[name];
    if (!real) continue;
    unpatched.set(name, real);
    subtle[name] = function (this: unknown, ...args: unknown[]) {
      subtleRunning += 1;
      return real.apply(this, args).finally(() => {
        subtleRunning -= 1;
      });
    };
  }
});
afterAll(() => {
  globalThis.setImmediate = turn;
  for (const [name, real] of unpatched) subtle[name] = real;
});

describe("an address without a key, in any order (analysis 19b)", () => {
  test(
    "opened only with a link of the list; absent said only once the list was checked",
    () =>
      hegel.testAsync(
        async (tc) => {
          const server = new FakeKeyringServer();
          const created = await createKeyring(ORIGIN, server.fetch);
          const here = tc.draw(gs.booleans());
          const there = tc.draw(gs.booleans());
          // The roles in play: the device's copy, the server, another tab.
          const hereLink = testLink("wanted", "read", 0, PAGE);
          const thereLink = testLink("wanted", "edit", 1, PAGE);
          const tabLink = testLink("wanted", "suggest", 2, PAGE);
          if (there) {
            const other = await KeyringSession.adopt(
              sessionOptions(
                {
                  local: openKeyringLocal({
                    indexedDB: new IDBFactory(),
                    lock,
                  }),
                  fetch: server.fetch,
                  setTimer: () => () => {},
                },
                ORIGIN,
              ),
              created,
            );
            await other?.change(
              (doc) => void rememberLink(doc, thereLink, { at: 1 }),
            );
            await other?.sync();
          }
          const indexedDB = new IDBFactory();
          const local = openKeyringLocal({ indexedDB, lock });
          const doc = newKeyringDoc();
          rememberLink(doc, testLink("other", "edit", 0, PAGE), { at: 1 });
          if (here) rememberLink(doc, hereLink, { at: 1 });
          await local.claim(created, doc);

          // Every request to the list's server waits for the test.
          const pending: { run: (reachable: boolean) => void }[] = [];
          let reading = 0;
          /** Requests taken (answered or not), and how many at the opening. */
          let taken = 0;
          let takenAtOpen: number | undefined;
          const fetch: typeof server.fetch = (url, init) =>
            new Promise((resolve, reject) => {
              pending.push({
                run: (reachable) => {
                  taken += 1;
                  if (!reachable) {
                    reject(new TypeError("offline"));
                    return;
                  }
                  reading += 1;
                  void server
                    .fetch(url, init)
                    .then(resolve, reject)
                    .finally(() => {
                      reading -= 1;
                    });
                },
              });
            });
          const timers = () => () => {};

          const opened: { role: string; secret: Uint8Array }[] = [];
          const items = new Map([["obsidian-collab:pseudonym", "alice"]]);
          document.body.innerHTML = "";
          const address = new URL(ADDRESS);
          const env: PageEnvironment = {
            root: document.body,
            location: () => address,
            replaceAddress: (url) => {
              address.href = url;
            },
            reload: () => {},
            storage: {
              getItem: (key: string) => items.get(key) ?? null,
              setItem: (key: string, value: string) =>
                void items.set(key, value),
              removeItem: (key: string) => void items.delete(key),
            } as unknown as Storage,
            indexedDB: undefined,
            lock: undefined,
            languages: ["en"],
            online: () => true,
            window: new EventTarget(),
            confirm: () => true,
            copy: async () => {},
            registerServiceWorker: async () => {},
            createDocument: () => Promise.reject(new Error("unexpected")),
            createKeyring: () => Promise.reject(new Error("unexpected")),
            now: () => Date.now(),
            documentLinks,
            keyring: { local, fetch, setTimer: timers },
            openDocument: (options) => {
              opened.push(options.credentials);
              takenAtOpen = taken;
              return Promise.reject(new ConnectionRefused(CloseCode.Deleted));
            },
          };

          // Another tab of this device, which may add the document.
          let tabAdded = false;
          const tab = tc.draw(gs.booleans())
            ? await KeyringSession.open(
                sessionOptions(
                  {
                    local: openKeyringLocal({ indexedDB, lock }),
                    fetch,
                    setTimer: timers,
                  },
                  ORIGIN,
                ),
              )
            : undefined;

          cryptoGate.start();
          let settled = false;
          const started = startPage(env).finally(() => {
            settled = true;
          });
          let reached = false;
          // Nothing in progress out of the test's hands: no request being
          // read, no WebCrypto work running, no IndexedDB step waiting.
          const quiet = async () => {
            const busy = () =>
              reading > 0 ||
              cryptoGate.running > 0 ||
              subtleRunning > 0 ||
              immediates > 0;
            do {
              do await tick();
              while (busy());
              await tick();
            } while (busy());
          };
          for (let idle = 0; !settled; ) {
            await quiet();
            if (settled) break;
            const canAdd = tab !== undefined && !tabAdded;
            const held = cryptoGate.held.length;
            if (pending.length === 0 && !canAdd && held === 0) {
              // The page's own steps (IndexedDB) still running.
              if (++idle > 1000) throw new Error("the page never settles");
              continue;
            }
            idle = 0;
            // 0: take a request, answered; 1: taken, the network down;
            // 2: the other tab adds the document; 3: an encryption or a
            // decryption ends.
            const choices = [
              ...(pending.length > 0 ? [0, 1] : []),
              ...(canAdd ? [2] : []),
              ...(held > 0 ? [3] : []),
            ];
            const choice = tc.draw(gs.sampledFrom(choices));
            if (choice === 3) {
              const at = tc.draw(
                gs.integers({ minValue: 0, maxValue: held - 1 }),
              );
              const work = cryptoGate.held[at];
              if (work) cryptoGate.release(work);
            } else if (choice < 2) {
              const at = tc.draw(
                gs.integers({ minValue: 0, maxValue: pending.length - 1 }),
              );
              if (choice === 0) reached = true;
              pending.splice(at, 1)[0]?.run(choice === 0);
            } else {
              tabAdded = true;
              void tab?.change((d) => void rememberLink(d, tabLink, { at: 2 }));
            }
          }
          await started;
          // What the other tab still asks for: answered, so nothing hangs.
          cryptoGate.stop();
          tab?.close();
          for (const request of pending.splice(0)) request.run(false);

          const notice =
            document.querySelector(".view-notices")?.textContent ?? "";
          const links = [hereLink, thereLink, tabLink];
          const secrets = links.map((link) =>
            new URLSearchParams(new URL(link).hash.slice(1)).get("r"),
          );
          if (opened.length > 0) {
            // Opened once, with a link of the list, which is the address.
            expect(opened).toHaveLength(1);
            const [only] = opened;
            const r = `${only?.role}.${bytesToBase64Url(only?.secret ?? new Uint8Array())}`;
            expect(secrets).toContain(r);
            expect(links).toContain(address.href);
            expect(address.href).not.toContain("h=");
            expect(address.href.endsWith(r)).toBe(true);
          } else {
            expect(address.href).toBe(ADDRESS);
            expect(here).toBe(false);
            if (notice.includes(t().keylessAbsent)) {
              // Checked: the server was reached, and didn't hold it.
              expect(reached).toBe(true);
              expect(there).toBe(false);
            } else {
              expect(notice).toContain(t().keylessUnchecked);
            }
          }
          // In this device's copy: opened without waiting for the network
          // (analysis 19b, case 1), whatever it did after.
          if (here) {
            expect(opened).toHaveLength(1);
            expect(takenAtOpen).toBe(0);
          }
        },
        { testCases: 200 },
      ),
    120_000,
  );
});
