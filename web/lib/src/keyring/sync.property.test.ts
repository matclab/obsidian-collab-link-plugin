// The keyring's synchronisation (docs/protocol/05-keyring.md, KR-25 –
// KR-27; docs/phase-18-trousseau-identite.md, analysis 18c, TR1): devices
// sync one keyring through a server that keeps one blob and a version
// (KR-7). The order in which the server takes their requests, and the
// local writes between them, are the test's choices. At the end, after a
// last round of syncs, the stored blob and every device list every
// document any device added: no accepted write lost another's.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { LoroDoc } from "loro-crdt";
import { describe, expect, test, vi } from "vitest";
import { bytesToBase64Url } from "../crypto/role-secrets.js";
import { decryptKeyring, newKeyringSecrets } from "./crypto.js";
import {
  listKeyring,
  newKeyringDoc,
  readKeyringPlaintext,
  rememberLink,
} from "./model.js";
import {
  type KeyringTransport,
  type SyncOutcome,
  syncKeyring,
} from "./sync.js";
import { testLink } from "./test-support/links.js";

/** WebCrypto at work: the only thing that ends outside the test's
 * choices (Loro runs in the same turn; the network waits for the test).
 * Counted, so that waiting is waiting for it, never a number of turns
 * (AGENTS.md §1.6): a loaded machine only makes it longer. */
const work = vi.hoisted(() => {
  let running = 0;
  let idle: (() => void)[] = [];
  return {
    running: () => running,
    /** Resolves once nothing is running. */
    idle: () =>
      running === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => idle.push(resolve)),
    count<A extends unknown[], R>(
      run: (...args: A) => Promise<R>,
    ): (...args: A) => Promise<R> {
      return async (...args) => {
        running++;
        try {
          return await run(...args);
        } finally {
          running--;
          if (running === 0) {
            for (const resolve of idle.splice(0)) resolve();
            idle = [];
          }
        }
      };
    },
  };
});

vi.mock("./crypto.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./crypto.js")>();
  return {
    ...real,
    encryptKeyring: work.count(real.encryptKeyring),
    decryptKeyring: work.count(real.decryptKeyring),
  };
});

type TC = Parameters<Parameters<typeof hegel.testAsync>[0]>[0];

const KEY = bytesToBase64Url(new Uint8Array(32).fill(0xa0));
const link = (doc: string) => testLink(doc);

/** A server of one keyring (KR-6, KR-7) whose requests wait, each, for
 * the test to let the server take them. */
class ScheduledKeyringServer {
  version = 0;
  blob: Uint8Array = new Uint8Array(0);
  pending: { device: number; run: () => void }[] = [];

  transport(device: number): KeyringTransport {
    const later = <T>(take: () => T) =>
      new Promise<T>((resolve) =>
        this.pending.push({ device, run: () => resolve(take()) }),
      );
    return {
      read: () => later(() => ({ version: this.version, blob: this.blob })),
      write: (version, blob) =>
        later(() => {
          if (version !== this.version) return { stale: this.version };
          this.version += 1;
          this.blob = blob;
          return { written: this.version };
        }),
    };
  }
}

/** Until `done` holds, waiting for WebCrypto as long as it runs: what
 * follows it runs in microtasks, which a macrotask's turn lets end. With
 * nothing running and `done` still false, nothing will make it true. */
async function until(done: () => boolean) {
  for (;;) {
    await work.idle();
    await new Promise((resolve) => setImmediate(resolve));
    if (done()) return;
    if (work.running() === 0) throw new Error("stuck");
  }
}

describe("the keyring's synchronisation", () => {
  test(
    "TR1: whatever the order of requests, no document added is lost",
    () =>
      hegel.testAsync(
        async (tc: TC) => {
          const { key } = newKeyringSecrets();
          const server = new ScheduledKeyringServer();
          const devices = tc.draw(gs.integers({ minValue: 2, maxValue: 3 }));
          const copies: LoroDoc[] = Array.from({ length: devices }, () =>
            newKeyringDoc(),
          );
          const running: (Promise<SyncOutcome> | null)[] = copies.map(
            () => null,
          );
          const settled: boolean[] = copies.map(() => true);
          const added = new Set<string>();
          const start = (d: number) => {
            settled[d] = false;
            running[d] = syncKeyring(
              copies[d] as LoroDoc,
              key,
              server.transport(d),
              {
                wait: async () => {},
              },
            ).finally(() => {
              settled[d] = true;
            });
          };
          // Wait until each device either waits on the server or is done.
          const quiet = () =>
            until(() =>
              copies.every(
                (_, d) =>
                  settled[d] || server.pending.some((p) => p.device === d),
              ),
            );

          let n = 0;
          for (
            let step = tc.draw(gs.integers({ minValue: 1, maxValue: 30 }));
            step > 0;
            step--
          ) {
            const d = tc.draw(
              gs.integers({ minValue: 0, maxValue: devices - 1 }),
            );
            switch (tc.draw(gs.integers({ minValue: 0, maxValue: 3 }))) {
              case 0: {
                const doc = `doc-${d}-${n++}`;
                rememberLink(copies[d] as LoroDoc, link(doc), { at: n });
                added.add(doc);
                break;
              }
              case 1:
                if (settled[d]) start(d);
                break;
              default:
                if (server.pending.length > 0) {
                  const i = tc.draw(
                    gs.integers({
                      minValue: 0,
                      maxValue: server.pending.length - 1,
                    }),
                  );
                  server.pending.splice(i, 1)[0]?.run();
                }
            }
            await quiet();
          }
          // The end: requests taken in order until every sync is done, then a
          // last sync of each device, alone, and again the first, so that it
          // sees what the others wrote last.
          const drain = async () => {
            while (server.pending.length > 0) {
              server.pending.shift()?.run();
              await quiet();
            }
          };
          await drain();
          for (const d of [...copies.keys(), 0]) {
            start(d);
            await quiet();
            await drain();
            expect((await running[d])?.kind).toBe("synced");
          }
          const stored = readKeyringPlaintext(
            await decryptKeyring(key, server.blob),
          );
          const listedOnServer = new Set(
            listKeyring(stored as LoroDoc).map((e) => e.documentId),
          );
          expect(listedOnServer).toEqual(added);
          for (const copy of copies.slice(0, 1)) {
            expect(new Set(listKeyring(copy).map((e) => e.documentId))).toEqual(
              added,
            );
          }
        },
        { testCases: 200 },
      ),
    // Each case encrypts and decrypts many times: seconds under a loaded run.
    120_000,
  );
});
