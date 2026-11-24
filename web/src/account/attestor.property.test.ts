// AT2 and cases 2, 3, 4, 7 of analysis 18k under an order the test draws
// (AGENTS.md §1.6): two tabs of a device, sharing its records, refresh
// their attestation while the gateway answers in any order, the
// account's keyring key changes mid-request (a keyring merged, another
// device's key), a token is refused, a token is recent or not, and the
// device's clock and the gateway's jump, together or apart. At every
// step: a tab gives an envelope only for its own key, valid now, signed
// by the configured gateway (AT2); the gateway holds only a key that was
// the account keyring's (SG2). At the end, the clocks agreeing, with a
// recent token and every answer delivered, each tab holds an attestation
// of the key of the moment — unless the gateway revoked that key.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import { sha256 } from "../../lib/src/annotations/sha256.js";
import {
  type Signer,
  generateIdentityKey,
  readAttestationEntry,
  signerOf,
} from "../../lib/src/index.js";
import { Attestor } from "./attestor.js";
import { memoryAccountLocal } from "./test-support.js";
import { DAY_S, KeysGateway } from "./test-support/keys-gateway.js";

type TC = Parameters<Parameters<typeof hegel.testAsync>[0]>[0];
const GATEWAY = "https://accounts.example";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

let poolPromise: Promise<Signer[]> | undefined;
const pool = () => {
  poolPromise ??= Promise.all(
    [0, 1, 2].map(async () => signerOf(await generateIdentityKey())),
  );
  return poolPromise;
};

interface Pending {
  tab: number;
  run(): void;
}

describe("the attestation of a device's key, in any order", () => {
  test("AT2: only its own key's, valid, from the configured gateway", () =>
    hegel.testAsync(
      async (tc: TC) => {
        const keys = await pool();
        const gateway = await KeysGateway.create();
        const local = memoryAccountLocal();
        let now = gateway.now; // the device's clock
        let tokenCount = 0;
        const signIn = (recent: boolean) => {
          tokenCount += 1;
          const token = `T${tokenCount}`;
          gateway.token(token, "u-1", recent);
          local.stored = {
            gateway: GATEWAY,
            token,
            deadline: now + 12 * 3600_000,
            ...(recent && { recentUntil: now + 600_000 }),
            name: "u-1",
            email: null,
            issuer: "https://idp.example",
            sub: "u-1",
          };
        };
        signIn(tc.draw(gs.booleans()));
        // The account keyring's key: what every tab signs with now.
        let current = keys[0] as Signer;
        const everCurrent = new Set([hex(current.publicKey)]);
        const queue: Pending[] = [];
        let queued = () => {};
        /** Per tab: answers it awaits, and whether it refreshes. */
        const waiting = [0, 0];
        // Refreshes in progress per tab: one asked while another runs is
        // run after it (analysis 18o.2).
        const running = [0, 0];
        const tabs = await Promise.all(
          [0, 1].map((tab) =>
            Attestor.open({
              gateway: GATEWAY,
              configured: new Set([gateway.fingerprint]),
              local,
              fetch: (url, init) =>
                new Promise<Response>((resolve, reject) => {
                  waiting[tab] = (waiting[tab] ?? 0) + 1;
                  queue.push({
                    tab,
                    run: () => {
                      waiting[tab] = (waiting[tab] ?? 1) - 1;
                      gateway.fetch(url, init).then(resolve, reject);
                    },
                  });
                  queued();
                }),
              now: () => now,
              setTimer: () => () => {},
              accountSigner: async () => current,
            }),
          ),
        );
        const refresh = (tab: number) => {
          running[tab] = (running[tab] ?? 0) + 1;
          void tabs[tab]?.refresh().finally(() => {
            running[tab] = (running[tab] ?? 1) - 1;
          });
        };
        /** Until each tab is idle, or waits on the gateway only: nothing in
         * progress outside the test's control (counters, never rounds). */
        const settle = async () => {
          for (;;) {
            const busy = [0, 1].filter(
              (tab) => (running[tab] ?? 0) > 0 && (waiting[tab] ?? 0) === 0,
            );
            if (busy.length === 0) return;
            const grew = new Promise<void>((resolve) => {
              queued = resolve;
            });
            await Promise.race([
              grew,
              ...busy.map((tab) => tabs[tab]?.refreshing()),
            ]);
            // `finally` above has run once the refresh's promise settled.
            await Promise.resolve();
          }
        };
        const check = async () => {
          for (const tab of tabs) {
            for (const key of keys) {
              const envelope = tab.envelopeFor(key.publicKey);
              if (!envelope) continue;
              const read = await readAttestationEntry(
                hex(sha256(envelope)),
                envelope,
                new Set([gateway.fingerprint]),
              );
              expect(read && hex(read.key), "AT2: its own key").toBe(
                hex(key.publicKey),
              );
              const valid =
                read !== undefined &&
                read.issuedAt * 1000 <= now &&
                now < read.expiresAt * 1000;
              expect(valid, "AT2: valid now").toBe(true);
            }
          }
          const held = gateway.accounts.get("u-1")?.key;
          if (held) {
            expect(everCurrent.has(hex(held)), "SG2").toBe(true);
          }
        };

        for (
          let step = tc.draw(gs.integers({ minValue: 1, maxValue: 14 }));
          step > 0;
          step--
        ) {
          switch (tc.draw(gs.integers({ minValue: 0, maxValue: 7 }))) {
            case 0:
              refresh(tc.draw(gs.integers({ minValue: 0, maxValue: 1 })));
              break;
            case 6: {
              // A composed gesture: a whole refresh of a tab, each answer
              // given as soon as asked — what makes a tab hold one.
              const tab = tc.draw(gs.integers({ minValue: 0, maxValue: 1 }));
              refresh(tab);
              for (;;) {
                await settle();
                const at = queue.findIndex((p) => p.tab === tab);
                if (at < 0) break;
                queue.splice(at, 1)[0]?.run();
              }
              break;
            }
            case 7:
            case 1: {
              // An answer, any of those awaited.
              if (queue.length === 0) break;
              const at = tc.draw(
                gs.integers({ minValue: 0, maxValue: queue.length - 1 }),
              );
              queue.splice(at, 1)[0]?.run();
              break;
            }
            case 2:
              // Case 2: the keyring's key changes, mid-request perhaps.
              current = tc.draw(gs.sampledFrom(keys));
              everCurrent.add(hex(current.publicKey));
              break;
            case 3:
              // Case 3: the token refused from now on.
              gateway.tokens.clear();
              break;
            case 4:
              signIn(tc.draw(gs.booleans()));
              break;
            default: {
              // Two clocks (AGENTS.md §1.6): both jump, or the device's
              // alone, ahead or behind — days, or past an end.
              const ms = tc.draw(
                gs.sampledFrom([
                  60_000,
                  DAY_S * 1000,
                  24 * DAY_S * 1000,
                  31 * DAY_S * 1000,
                  -3600_000,
                ]),
              );
              now += ms;
              if (tc.draw(gs.booleans()) && ms > 0) gateway.now += ms;
              break;
            }
          }
          await settle();
          await check();
        }

        // Liveness: the clocks agreeing, a recent token, every answer given.
        now = Math.max(now, gateway.now);
        gateway.now = now;
        signIn(true);
        for (;;) {
          await settle();
          const next = queue.shift();
          if (!next) break;
          next.run();
        }
        for (const tab of [0, 1]) {
          refresh(tab);
          for (;;) {
            await settle();
            const next = queue.shift();
            if (!next) break;
            next.run();
          }
          await tabs[tab]?.refreshing();
        }
        await check();
        // A key revoked is never attested again (GW1): nothing to expect.
        if (gateway.revoked.has(hex(current.publicKey))) return;
        for (const tab of tabs) {
          expect(
            tab.envelopeFor(current.publicKey),
            "attested in the end",
          ).toBeInstanceOf(Uint8Array);
        }
      },
      { testCases: 100 },
    ));
});
