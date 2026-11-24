// @vitest-environment node
//
// Signing in across the tabs of a device (docs/phase-18-trousseau-
// identite.md, analysis 18i.2, CN1 – CN4, cases 1 – 8; AGENTS.md §1.6).
// Two tabs share the account kept on the device. Every source of order is
// a choice of the test:
// - clicks on « S'identifier », « Annuler », « Se déconnecter »;
// - the window's return for one of a tab's attempts (a code or a
//   refusal), a return replayed, one forged by another page of the origin;
// - when each message between pages is delivered, in any order;
// - when the gateway answers each request, and how (a token, a refusal,
//   no network) — or never;
// - when each write to the device's record ends, in their order, as
//   IndexedDB's transactions on one store do;
// - the device's clock, to each timer;
// - a tab reloaded, each of its writes in progress landing or not.
// Checked at each step, against a model of each tab's attempt in progress:
// - CN1: a message starts an exchange exactly when it is a return of the
//   tab's attempt awaiting its window; once per attempt; with that
//   attempt's verifier;
// - CN3: the gateway is never told to end a token kept on the device;
// - ID-25: a token kept has the deadline of its sending, on the device's
//   clock — the gateway's `expires_at` is hours off either way;
// - a tab shows « pending » exactly while the model has an attempt.
// At the end, everything delivered and written:
// - CN2: no token of an attempt given up is kept, and each was ended;
// - CN4: each tab shows what is kept.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import {
  type SignInAttempt,
  TOKEN_MS,
  readSignInMessage,
} from "../../lib/src/index.js";
import type { AccountLocal, SignedIn } from "../keyring/local.js";
import { SIGN_IN_CHANNEL, SignIn } from "./sign-in.js";
import { ChannelBus, codeOf, knownAttempt } from "./test-support.js";

const GATEWAY = "https://accounts.example";
const TABS = 2;

/** Every microtask run: the code's promises all are, the doubles' answers
 * being plain promises. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** As much of a `Response` as the library reads: a real one's body ends
 * when the runtime says, not the test. */
function answer(status: number, body?: unknown): Response {
  return { status, json: async () => body } as unknown as Response;
}

interface Call {
  page: object;
  path: string;
  init?: RequestInit;
  resolve(response: Response): void;
  reject(error: Error): void;
  sentAt: number;
  /** An exchange's: the attempt it is for. */
  request?: string;
}

/** The device's record, its writes ending in their order when the test
 * says. */
class DeviceRecord {
  stored: SignedIn | undefined;
  queue: { page: object; apply: () => unknown; resolve(v: unknown): void }[] =
    [];
  readonly gone = new Set<object>();

  forPage(page: object): AccountLocal {
    const later = <T>(apply: () => T) =>
      new Promise<T>((resolve) => {
        this.queue.push({
          page,
          apply,
          resolve: resolve as (v: unknown) => void,
        });
      });
    return {
      signedIn: () => later(() => this.stored && { ...this.stored }),
      keepSignedIn: (account) =>
        later(() => {
          this.stored = { ...account };
        }),
      forgetSignedIn: (token) =>
        later(() => {
          if (this.stored?.token === token) this.stored = undefined;
        }),
      associationLater: async () => false,
      keepAssociationLater: async () => {},
      identityName: async () => undefined,
      keepIdentityName: async () => {},
      // Signing in doesn't read nor write the attestation.
      attestation: async () => undefined,
      keepAttestation: async () => {},
      refusedKey: async () => undefined,
      keepRefusedKey: async () => {},
    };
  }

  /** The first write ends; its page told, if still there. */
  next(): void {
    const head = this.queue.shift();
    if (!head) return;
    const value = head.apply();
    if (!this.gone.has(head.page)) head.resolve(value);
  }
}

interface Tab {
  page: object;
  signIn: SignIn;
  opened: SignInAttempt[];
  /** The model: its attempt in progress. */
  current: { request: string; phase: "window" | "exchange" } | undefined;
}

/** A token of the gateway's form, distinct for each `n`. */
function tokenOf(n: number): string {
  const bytes = new Uint8Array(32).fill(0x5a);
  bytes[0] = n & 0xff;
  bytes[1] = n >> 8;
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("signing in across the tabs of a device", () => {
  test(
    "CN1 – CN4, whatever the order",
    () =>
      hegel.testAsync(
        async (tc) => {
          const draw = (max: number) =>
            tc.draw(gs.integers({ minValue: 0, maxValue: Math.max(0, max) }));
          const bus = new ChannelBus();
          const record = new DeviceRecord();
          const calls: Call[] = [];
          let seen = 0;
          const clock = { now: 1_800_000_000_000 };
          const timers: {
            page: object;
            at: number;
            run: () => void;
            live: boolean;
          }[] = [];
          // Made beforehand: WebCrypto's digest ends when it ends.
          const pool = await Promise.all(
            Array.from({ length: 30 }, () => knownAttempt()),
          );
          const attempts = new Map(pool.map((a) => [a.request, a]));
          const exchangedFor = new Set<string>();
          const givenUp = new Set<string>();
          /** Tokens the gateway gave: their request, the page, the time of
           * their sending. */
          const tokens = new Map<
            string,
            { request: string; page: object; sentAt: number }
          >();
          const ended = new Set<string>();
          /** Tokens that came after their attempt was given up. */
          const late = new Set<string>();
          const reloaded = new Set<object>();
          let nextCode = 1;

          const openTab = async (): Promise<Tab> => {
            const page = {};
            const tab: Tab = {
              page,
              signIn: undefined as unknown as SignIn,
              opened: [],
              current: undefined,
            };
            const opening = SignIn.open({
              gateway: GATEWAY,
              local: record.forPage(page),
              fetch: (url, init) =>
                new Promise((resolve, reject) => {
                  calls.push({
                    page,
                    path: new URL(url).pathname,
                    ...(init && { init }),
                    resolve,
                    reject,
                    sentAt: clock.now,
                  });
                }),
              setTimer: (run, ms) => {
                const timer = { page, at: clock.now + ms, run, live: true };
                timers.push(timer);
                return () => {
                  timer.live = false;
                };
              },
              now: () => clock.now,
              openWindow: (url) => {
                const address = new URL(url);
                const attempt = attempts.get(
                  address.searchParams.get("request") ?? "",
                );
                expect(attempt, "an attempt of this tab").toBeDefined();
                expect(address.searchParams.get("challenge")).toBe(
                  attempt?.challenge,
                );
                // Two clicks: the first attempt is given up (case 2).
                if (tab.current) givenUp.add(tab.current.request);
                tab.opened.push(attempt as SignInAttempt);
                tab.current = {
                  request: (attempt as SignInAttempt).request,
                  phase: "window",
                };
              },
              channel: (name) => bus.channel(name),
              newAttempt: async () => {
                const attempt = pool.shift();
                if (!attempt) throw new Error("no attempt left");
                return attempt;
              },
            });
            await settle();
            // Its health answered, its record read, before the steps.
            const health = calls.findIndex(
              (c) => c.page === page && c.path === "/accounts/health",
            );
            calls.splice(health, 1)[0]?.resolve(answer(200, {}));
            seen = Math.min(seen, calls.length);
            while (record.queue.some((op) => op.page === page)) {
              record.next();
              await settle();
            }
            tab.signIn = await opening;
            await settle();
            return tab;
          };

          const tabs: Tab[] = [];
          for (let i = 0; i < TABS; i++) tabs.push(await openTab());
          // Their openings told and read (CN4): no message left from before
          // the steps, which would have every tab read again at the end.
          while (bus.queue.length > 0 || record.queue.length > 0) {
            if (bus.queue.length > 0) bus.deliver();
            else record.next();
            await settle();
          }

          /** The requests a step made: CN1 against `expected`, CN3. */
          const checkCalls = (
            expected: { tab: Tab; request: string; code: string } | undefined,
          ) => {
            const fresh = calls.slice(seen);
            seen = calls.length;
            const sessions = fresh.filter(
              (c) => c.path === "/accounts/session",
            );
            expect(sessions.length, "CN1: an exchange iff expected").toBe(
              expected ? 1 : 0,
            );
            const [session] = sessions;
            if (session && expected) {
              expect(session.page).toBe(expected.tab.page);
              expect(JSON.parse(String(session.init?.body)), "CN1").toEqual({
                code: expected.code,
                verifier: attempts.get(expected.request)?.verifier,
              });
              expect(exchangedFor.has(expected.request), "CN1: once").toBe(
                false,
              );
              exchangedFor.add(expected.request);
              session.request = expected.request;
            }
            for (const logout of fresh.filter(
              (c) => c.path === "/accounts/logout",
            )) {
              const token = String(
                (logout.init?.headers as Record<string, string>).Authorization,
              ).replace("Bearer ", "");
              expect(record.stored?.token, "CN3").not.toBe(token);
              ended.add(token);
            }
          };

          /** Delivers a message; the model says which exchange it starts. */
          const deliver = (index: number) => {
            const message = bus.queue[index];
            if (!message) return;
            let expected:
              | { tab: Tab; request: string; code: string }
              | undefined;
            const read =
              message.name === SIGN_IN_CHANNEL
                ? readSignInMessage(message.data)
                : undefined;
            const tab =
              read &&
              tabs.find(
                (t) =>
                  t.current?.phase === "window" &&
                  t.current.request === read.request,
              );
            if (read && tab) {
              if ("code" in read) {
                expected = { tab, request: read.request, code: read.code };
                tab.current = { request: read.request, phase: "exchange" };
              } else {
                tab.current = undefined;
              }
            }
            bus.deliver(index);
            checkCalls(expected);
          };

          /** Reloaded: its writes in progress land or not; its requests
           * are never answered; its attempt is lost (case 5). */
          const reload = async (tab: Tab) => {
            const index = tabs.indexOf(tab);
            tab.signIn.close();
            record.gone.add(tab.page);
            reloaded.add(tab.page);
            record.queue = record.queue.filter(
              (op) => op.page !== tab.page || draw(1) === 0,
            );
            for (let i = calls.length - 1; i >= 0; i--) {
              if (calls[i]?.page !== tab.page) continue;
              calls.splice(i, 1);
              if (i < seen) seen -= 1;
            }
            tabs[index] = await openTab();
          };

          /** Takes the request at `index`, if the test saw it made. */
          const takeCall = (index: number): Call | undefined => {
            if (index < 0 || index >= seen) return undefined;
            seen -= 1;
            return calls.splice(index, 1)[0];
          };

          /** The gateway's answer to an exchange: `how` 0 refuses, 1 has no
           * network, else a token. */
          const answerSession = (call: Call, how: number) => {
            if (how === 0) return call.resolve(answer(401));
            if (how === 1) return call.reject(new TypeError("network"));
            const token = tokenOf(tokens.size);
            const request = call.request ?? "";
            tokens.set(token, {
              request,
              page: call.page,
              sentAt: call.sentAt,
            });
            if (givenUp.has(request)) late.add(token);
            call.resolve(
              answer(200, {
                token,
                // The gateway's clock, hours off: never read (ID-25).
                expires_at: draw(1) === 0 ? 0 : 9_999_999_999,
                name: "Ada",
                email: null,
                issuer: "https://idp.example",
                sub: `u-${tokens.size}`,
              }),
            );
          };

          const steps = draw(40);
          for (let step = 0; step < steps; step++) {
            const tab = tabs[draw(TABS - 1)] as Tab;
            const action = draw(12);
            switch (action) {
              case 0:
                tab.signIn.start();
                break;
              case 1:
                if (tab.current) givenUp.add(tab.current.request);
                tab.current = undefined;
                tab.signIn.cancel();
                break;
              case 2:
                void tab.signIn.signOut();
                break;
              case 3: {
                // The window of one of its attempts comes back.
                const attempt = tab.opened[draw(tab.opened.length - 1)];
                if (!attempt) break;
                bus.postFromElsewhere(
                  SIGN_IN_CHANNEL,
                  draw(3) === 0
                    ? { error: "denied", request: attempt.request }
                    : {
                        code: codeOf(nextCode++ % 250),
                        request: attempt.request,
                      },
                );
                break;
              }
              case 4: {
                // Replayed, or forged by another page of the origin: a code
                // of the right form, for any request.
                const request =
                  tab.opened[draw(tab.opened.length - 1)]?.request ?? "0";
                bus.postFromElsewhere(
                  SIGN_IN_CHANNEL,
                  tc.draw(
                    gs.sampledFrom<unknown>([
                      { code: codeOf(251), request },
                      { code: codeOf(251), request: "e".repeat(32) },
                      { code: codeOf(251), request, more: "1" },
                      { code: "short", request },
                      { error: "failed", request },
                      "anything",
                      null,
                    ]),
                  ),
                );
                break;
              }
              case 5:
                deliver(draw(bus.queue.length - 1));
                break;
              case 6: {
                // The gateway answers one request.
                const call = takeCall(draw(seen - 1));
                if (!call) break;
                if (call.path !== "/accounts/session") {
                  if (draw(1) === 0) call.resolve(answer(204));
                  else call.reject(new TypeError("network"));
                  break;
                }
                answerSession(call, draw(3));
                break;
              }
              case 7:
                record.next();
                break;
              case 8: {
                // The clock, to the next timer of a page still there.
                const [live] = timers
                  .filter((t) => t.live && !record.gone.has(t.page))
                  .sort((a, b) => a.at - b.at);
                if (!live) break;
                clock.now = Math.max(clock.now, live.at);
                live.live = false;
                live.run();
                break;
              }
              case 9:
                await reload(tab);
                break;
              case 10:
              case 11: {
                // Composite (AGENTS.md §1.6): a whole sign-in; or one with
                // « Annuler » during its exchange or its keeping (case 3).
                tab.signIn.start();
                await settle();
                checkCalls(undefined);
                const request =
                  tab.current?.phase === "window"
                    ? tab.current.request
                    : undefined;
                if (!request) break;
                bus.postFromElsewhere(SIGN_IN_CHANNEL, {
                  code: codeOf(nextCode++ % 250),
                  request,
                });
                deliver(bus.queue.length - 1);
                await settle();
                checkCalls(undefined);
                const exchange = takeCall(
                  calls.findIndex((c) => c.request === request),
                );
                if (!exchange) break;
                const cancel = () => {
                  givenUp.add(request);
                  tab.current = undefined;
                  tab.signIn.cancel();
                };
                // « Annuler » before the token comes, or while it is kept.
                const when = action === 11 ? draw(1) : -1;
                if (when === 0) cancel();
                answerSession(exchange, 3);
                await settle();
                checkCalls(undefined);
                if (when === 1) cancel();
                // Its keeping lands, waits, or the tab is reloaded first.
                const then = draw(2);
                if (then === 0) record.next();
                if (then === 2) await reload(tab);
                break;
              }
              default:
                clock.now += draw(3_600_000);
            }
            await settle();
            checkCalls(undefined);
            // An exchange ends when the tab is done with it: the model
            // follows (a token, a refusal, no network).
            for (const t of tabs) {
              const pending = t.signIn.state().kind === "pending";
              if (t.current?.phase === "exchange" && !pending) {
                t.current = undefined;
              }
              expect(pending, "pending iff an attempt").toBe(
                t.current !== undefined,
              );
            }
            // CN2: a token that came after its attempt was given up is
            // never even written.
            expect(late.has(record.stored?.token ?? ""), "CN2").toBe(false);
            // ID-25.
            const kept = record.stored;
            if (kept) {
              expect(kept.deadline).toBe(
                (tokens.get(kept.token)?.sentAt ?? Number.NaN) + TOKEN_MS,
              );
            }
          }

          // Everything delivered and written; the gateway's answers not
          // given stay so (a gateway that never answers).
          for (let round = 0; round < 200; round++) {
            if (bus.queue.length > 0) deliver(0);
            else if (record.queue.length > 0) record.next();
            else break;
            await settle();
            checkCalls(undefined);
          }
          expect(bus.queue).toEqual([]);
          expect(record.queue).toEqual([]);
          // CN2.
          for (const [token, { request, page }] of tokens) {
            if (!givenUp.has(request) || reloaded.has(page)) continue;
            expect(record.stored?.token, "CN2: never kept").not.toBe(token);
            expect(ended.has(token), "CN2: ended").toBe(true);
          }
          // CN4.
          const kept =
            record.stored && record.stored.deadline > clock.now
              ? record.stored
              : undefined;
          for (const tab of tabs) {
            const state = tab.signIn.state();
            if (state.kind === "pending") continue;
            if (kept) {
              expect(state, "CN4").toMatchObject({
                kind: "signed-in",
                sub: kept.sub,
              });
            } else {
              expect(state.kind, "CN4").not.toBe("signed-in");
            }
          }
        },
        { testCases: 1000 },
      ),
    600_000,
  );
});
