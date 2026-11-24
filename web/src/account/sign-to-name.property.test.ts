// AT3 and decision 20 under an order the test draws (analysis 18k, case
// 5; AGENTS.md §1.6): objects to sign asked for at any moment; the
// person's answer, when the test says — sign in, continue without, close
// the dialog, cancel the sign-in —; the sign-in's end — signed in,
// refused, a return after « Annuler » —; the attestation's refresh, or
// its time limit, ending; the page closed at any moment. At every step:
// nothing let through while the question waits; the question asked at
// most once a page, never once « continue without » was answered on this
// device. At the end, every object asked for let through exactly once —
// unless the page closed: then nothing more afterwards. What is let
// through is counted as the gate lets it, synchronously. Signed in, the
// reason the name isn't carried yet (analysis 18o.3, IC4) is a choice of
// the test, changed at any moment; « Confirmer » is a recent sign-in,
// « Réessayer » a retry ending when the test says. One question a page,
// whatever its reason; none shown while anything is let through.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import type { AccountState } from "./sign-in.js";
import { type NotYet, type PromptView, SignToName } from "./sign-to-name.js";

type TC = Parameters<Parameters<typeof hegel.testAsync>[0]>[0];

const SIGNED_IN: AccountState = {
  kind: "signed-in",
  name: "Ada",
  email: null,
  issuer: "i",
  sub: "s",
};

describe("asking to sign in before the first signed object", () => {
  test("AT3: let through once, never while the question waits", () =>
    hegel.testAsync(
      async (tc: TC) => {
        let state: AccountState = tc.draw(gs.booleans())
          ? { kind: "signed-out", ready: true }
          : tc.draw(
              gs.sampledFrom<AccountState>([
                SIGNED_IN,
                { kind: "unavailable" },
              ]),
            );
        const listeners = new Set<() => void>();
        const setState = (next: AccountState) => {
          state = next;
          for (const listener of [...listeners]) listener();
        };
        let remembered =
          tc.draw(gs.integers({ minValue: 0, maxValue: 4 })) === 0;
        const initiallyRemembered = remembered;
        let view: PromptView = "hidden";
        // Read through a function: set by the gate, out of TS's sight.
        const viewNow = (): PromptView => view;
        let asked = 0;
        let askedSignedOut = 0;
        const REASONS = [undefined, "confirm", "unconfirmed", "home"] as const;
        let reason: NotYet | undefined = tc.draw(gs.sampledFrom([...REASONS]));
        const retries: (() => void)[] = [];
        const starts: ({ recent?: boolean } | undefined)[] = [];
        let confirmed = 0;
        const refreshes: (() => void)[] = [];
        const timers: (() => void)[] = [];
        let closed = false;
        let letThrough = 0;
        let letThroughAfterClose = 0;
        const gate = new SignToName({
          account: {
            state: () => state,
            start: (options) => {
              starts.push(options);
              setState({ kind: "pending" });
            },
            cancel: () => setState({ kind: "signed-out", ready: true }),
            subscribe: (listener) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
          },
          remembered: () => remembered,
          remember: () => {
            // Only the question signed out is remembered (IC4).
            expect(view, "remembered signed out only").toBe("asking");
            remembered = true;
          },
          show: (next) => {
            const question = (v: PromptView) =>
              v !== "hidden" && v !== "pending";
            if (question(next) && !question(view)) asked += 1;
            if (next === "asking" && view !== "asking") askedSignedOut += 1;
            view = next;
          },
          notYet: () => reason,
          retry: () => new Promise<void>((resolve) => retries.push(resolve)),
          attested: () =>
            new Promise<void>((resolve) => refreshes.push(resolve)),
          setTimer: (run) => {
            timers.push(run);
            return () => {};
          },
          onLetThrough: () => {
            expect(view, "nothing let through while asking").toBe("hidden");
            if (closed) letThroughAfterClose += 1;
            else letThrough += 1;
          },
        });
        const objects: Promise<void>[] = [];

        for (
          let step = tc.draw(gs.integers({ minValue: 1, maxValue: 16 }));
          step > 0 && !closed;
          step--
        ) {
          switch (tc.draw(gs.integers({ minValue: 0, maxValue: 13 }))) {
            case 0:
              objects.push(gate.before());
              break;
            case 1:
              // A composed gesture: an object, its attestation ended and
              // what follows run — a question signed in is otherwise
              // rarely raised twice in a case.
              objects.push(gate.before());
              refreshes.pop()?.();
              await new Promise((resolve) => setTimeout(resolve, 0));
              // …and the question it raised answered.
              switch (
                tc.draw(gs.sampledFrom(["none", "confirm", "retry", "without"]))
              ) {
                case "confirm":
                  if (viewNow() === "confirm") confirmed += 1;
                  gate.confirm();
                  break;
                case "retry":
                  gate.retry();
                  break;
                case "without":
                  gate.without();
                  break;
              }
              break;
            case 2:
              gate.signIn();
              // A composed gesture: the whole sign-in, up to the
              // attestation awaited — rarely drawn otherwise.
              if (tc.draw(gs.booleans())) {
                setState(SIGNED_IN);
                // …and the page closed while the attestation is awaited.
                if (tc.draw(gs.booleans())) {
                  closed = true;
                  gate.close();
                }
              }
              break;
            case 3:
              gate.without();
              break;
            case 4:
              gate.dismiss();
              break;
            case 5:
              gate.cancel();
              break;
            case 6:
              // The sign-in's end — or a return after « Annuler », which
              // the gate no longer waits for.
              setState(
                tc.draw(gs.booleans())
                  ? SIGNED_IN
                  : { kind: "signed-out", ready: true, reason: "denied" },
              );
              break;
            case 7:
              refreshes.shift()?.();
              break;
            case 8:
              timers.shift()?.();
              break;
            case 10:
              reason = tc.draw(gs.sampledFrom([...REASONS]));
              break;
            case 11:
              if (viewNow() === "confirm") confirmed += 1;
              gate.confirm();
              break;
            case 12:
              gate.retry();
              break;
            case 13:
              retries.shift()?.();
              break;
            default:
              closed = true;
              gate.close();
              break;
          }
          // What the test let end (a refresh, a retry) runs on before the
          // next step, or not: the test's choice.
          if (tc.draw(gs.booleans())) {
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          if (view !== "hidden") {
            expect(gate.held(), "held while asking").toBeGreaterThan(0);
          }
          expect(asked, "once a page").toBeLessThanOrEqual(1);
          if (initiallyRemembered) {
            expect(askedSignedOut, "remembered").toBe(0);
          }
          // « Confirmer »: a recent sign-in (IC1).
          expect(
            starts.filter((o) => o?.recent === true).length,
            "confirmed recent",
          ).toBe(confirmed);
        }
        // The end: answered, every refresh, retry and time limit ended.
        gate.dismiss();
        const drain = () => {
          while (
            refreshes.length > 0 ||
            timers.length > 0 ||
            retries.length > 0
          ) {
            refreshes.shift()?.();
            timers.shift()?.();
            retries.shift()?.();
          }
          // A question an object raised once its attestation ended.
          if (view !== "hidden") gate.dismiss();
        };
        drain();
        if (closed) {
          // One task: every microtask still queued has run.
          await new Promise((resolve) => setTimeout(resolve, 0));
          drain();
          await new Promise((resolve) => setTimeout(resolve, 0));
          expect(letThroughAfterClose, "nothing after the page closed").toBe(0);
          return;
        }
        // Every object let through: until then, what it waits for ended
        // (counted, not timed).
        let ended = 0;
        for (const object of objects) {
          void object.then(() => {
            ended += 1;
          });
        }
        while (ended < objects.length) {
          drain();
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        expect(view).toBe("hidden");
        expect(gate.held(), "none held").toBe(0);
        expect(letThrough, "each let through once").toBe(objects.length);
      },
      { testCases: 300 },
    ));
});
