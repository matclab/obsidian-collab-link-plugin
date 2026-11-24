// @vitest-environment jsdom
// The identity of a document view under a controlled order (AGENTS.md
// §1.6; phase 38b, DV1 – DV5): the trust read, its account, the
// association, the header built (the bar's chip and the menu's section,
// in one go as the view does), the document open (the author followed),
// the account's and the list's changes, an index given to be trusted,
// the view closed: each when Hegel says.
//
// At every step: before the account is read, no question (DV5); a pending
// sign-in keeps the name signed in (DV4); open, the author followed saw
// the last name (DV3), and the chip is the line's. Closed: nothing created
// any more, nothing left listening, the trust closed once (DV1); each
// index tied to the trust once (DV2).
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import type { AccountState } from "../account/sign-in.js";
import type { AccountGate, Trust } from "../account/trust.js";
import { setLanguage } from "../i18n/index.js";
import type { DocumentSituation } from "../keyring/document-association.js";
import {
  type IdentityChip,
  chipOf,
  identityLine,
} from "../ui/header/identity-line.js";
import { OwnSignature } from "../view-model/own-signature.svelte.js";
import { PageMe } from "../view-model/page-me.js";
import { followViewIdentity } from "./view-identity.js";

type TC = Parameters<Parameters<typeof hegel.testAsync>[0]>[0];

/** Every microtask run: the next macrotask comes after them all, and
 * nothing here waits on a timer or the network (the trust's are fakes). */
const quiet = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const STATES: AccountState[] = [
  { kind: "signed-out", ready: true },
  { kind: "pending" },
  {
    kind: "signed-in",
    name: "Ada",
    email: null,
    issuer: "i",
    sub: "s",
  },
  {
    kind: "signed-in",
    name: "Grace",
    email: null,
    issuer: "i",
    sub: "t",
  },
];

const SITUATIONS: DocumentSituation[] = [
  { kind: "signed-out" },
  { kind: "unknown" },
  { kind: "associated" },
  { kind: "automatic" },
];

const identityScenario = async (tc: TC): Promise<void> => {
  setLanguage("en");
  document.body.innerHTML = "";
  const root = document.createElement("div");
  document.body.append(root);

  // The account: its state, its listeners.
  let state = STATES[0] as AccountState;
  const accountListeners = new Set<() => void>();
  const account: AccountGate = {
    state: () => state,
    start: () => {},
    cancel: () => {},
    subscribe: (listener) => {
      accountListeners.add(listener);
      return () => accountListeners.delete(listener);
    },
    recent: () => false,
  };
  // The list: its situation, its listeners.
  let situation = SITUATIONS[0] as DocumentSituation;
  const listListeners = new Set<() => void>();
  const association = {
    situation: () => situation,
    subscribe: (listener: () => void) => {
      listListeners.add(listener);
      return () => listListeners.delete(listener);
    },
    settled: async () => {},
    retry: async () => {},
  };
  // The trust: closed how many times, its revocations' listeners.
  let trustClosed = 0;
  const revocationListeners = new Set<() => void>();
  const judgeListeners = new Set<() => void>();
  const accountRead = deferred<AccountGate | undefined>();
  const trust: Trust = {
    attestationKeys: new Set(["k"]),
    revocations: {
      current: () => undefined,
      subscribe: (listener: () => void) => {
        revocationListeners.add(listener);
        return () => revocationListeners.delete(listener);
      },
    } as unknown as Trust["revocations"],
    attestation: () => undefined,
    refusedKey: () => undefined,
    refresh: async () => undefined,
    subscribe: (listener) => {
      judgeListeners.add(listener);
      return () => judgeListeners.delete(listener);
    },
    setTimer: () => () => {},
    account: accountRead.promise,
    close: () => {
      trustClosed += 1;
    },
  };
  const withTrust = tc.draw(gs.booleans());
  const withAccount = tc.draw(gs.booleans());
  const withAssociation = tc.draw(gs.booleans());
  const trustRead = deferred<Trust | undefined>();
  const associationRead = deferred<typeof association | undefined>();

  const stops: (() => void)[] = [];
  let closed = false;
  stops.push(() => {
    closed = true;
  });
  const identity = followViewIdentity({
    root,
    target: {
      apiBase: "https://collab.test",
      trust: trustRead.promise,
      association: associationRead.promise as never,
    },
    storage: undefined,
    own: new OwnSignature(),
    me: new PageMe(""),
    followKeys: async () => {},
    stops,
    closed: () => closed,
  });

  /** What the model knows has happened, while the view was open. */
  let trustIn: "no" | "yes" | "none" | "after-close" = "no";
  let accountIn: "no" | "yes" | "none" | "after-close" = "no";
  let associationIn: "no" | "yes" | "none" = "no";
  let header = false;
  let opened = false;
  /** The name signed in, as the model follows it (DV4). */
  let signedName: string | undefined;
  /** Read once followed and not pending (« Confirmer » keeps it, DV4). */
  let nameRead = false;
  let accountFollowed = false;
  const followed: ({ name: string | undefined } | undefined)[] = [];
  let chip: IdentityChip | undefined;
  let chipShown = false;
  const indexes: { keys: number; revocations: number }[] = [];
  let dialogsAtClose = 0;
  let sectionAtClose = "";
  const section = document.createElement("section");

  const moves = [
    "trust",
    "account",
    "association",
    "header",
    "open",
    "state",
    "situation",
    "trusted",
    "close",
  ] as const;
  const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 30 }));
  for (let step = 0; step < steps; step++) {
    const move = tc.draw(gs.sampledFrom([...moves]));
    switch (move) {
      case "trust":
        if (trustIn !== "no") break;
        trustIn = !withTrust ? "none" : closed ? "after-close" : "yes";
        trustRead.resolve(withTrust ? trust : undefined);
        // Its account, if read already, follows now (if open).
        if (trustIn === "yes" && accountIn === "yes") accountFollowed = true;
        break;
      case "account":
        if (accountIn !== "no") break;
        accountIn = !withAccount ? "none" : closed ? "after-close" : "yes";
        accountRead.resolve(withAccount ? account : undefined);
        if (trustIn === "yes" && accountIn === "yes") accountFollowed = true;
        break;
      case "association":
        if (associationIn !== "no") break;
        associationIn = withAssociation ? "yes" : "none";
        associationRead.resolve(withAssociation ? association : undefined);
        break;
      case "header":
        if (header || closed) break;
        header = true;
        identity.setChip((shown) => {
          chip = shown;
          chipShown = true;
        });
        identity.setMenu(section);
        break;
      case "open":
        if (!header || opened || closed) break;
        opened = true;
        identity.setFollowAuthor(() => followed.push(identity.account()));
        followed.push(identity.account());
        break;
      case "state": {
        state = tc.draw(gs.sampledFrom(STATES));
        for (const listener of [...accountListeners]) listener();
        break;
      }
      case "situation":
        situation = tc.draw(gs.sampledFrom(SITUATIONS));
        for (const listener of [...listListeners]) listener();
        break;
      case "trusted": {
        // As the view does: while it opens, before it can be closed.
        if (closed) break;
        const counts = { keys: 0, revocations: 0 };
        indexes.push(counts);
        identity.trusted({
          setAttestationKeys: () => {
            counts.keys += 1;
          },
          setRevocations: () => {
            counts.revocations += 1;
          },
        });
        break;
      }
      case "close":
        if (closed) break;
        for (const stop of stops.splice(0)) stop();
        dialogsAtClose = root.querySelectorAll("dialog").length;
        sectionAtClose = section.innerHTML;
        break;
    }
    await quiet();

    if (accountFollowed && !closed && state.kind !== "pending") {
      signedName = state.kind === "signed-in" ? state.name : undefined;
      nameRead = true;
    }
    if (closed) {
      // DV1: nothing listening, nothing created, the trust closed once.
      expect(accountListeners.size).toBe(0);
      expect(listListeners.size).toBe(0);
      expect(judgeListeners.size).toBe(0);
      expect(revocationListeners.size).toBe(0);
      expect(trustClosed).toBe(trustIn === "no" || trustIn === "none" ? 0 : 1);
      expect(root.querySelectorAll("dialog").length).toBe(dialogsAtClose);
      expect(section.innerHTML).toBe(sectionAtClose);
    } else {
      expect(trustClosed).toBe(0);
      // DV5: the question once the account is read, not before.
      expect(identity.gate() !== undefined).toBe(accountFollowed);
      // DV4, DV3: the name signed in, pending kept; the author followed
      // saw it last.
      expect(identity.account()).toEqual(
        nameRead ? { name: signedName } : undefined,
      );
      if (opened) expect(followed.at(-1)).toEqual(identity.account());
      // The chip is the line's, once both exist.
      if (accountFollowed && associationIn !== "no" && header) {
        expect(chipShown).toBe(true);
        expect(chip).toEqual(
          chipOf(
            identityLine({
              account: state,
              list:
                associationIn === "yes" ? situation : { kind: "signed-out" },
            }),
          ),
        );
      }
    }
    // DV2: each index tied once, if the trust is (and only while open).
    if (trustIn === "yes") {
      for (const counts of indexes) expect(counts.keys).toBeLessThanOrEqual(1);
    }
  }
  // Once quiet: every index given while the trust was read is tied (DV2).
  if (trustIn === "yes" && !closed) {
    for (const counts of indexes) expect(counts.keys).toBe(1);
  }
};

describe("a view's identity under a controlled order", () => {
  test(
    "DV1 – DV5 at every step, whatever the order",
    () => hegel.testAsync(identityScenario, { testCases: 400 }),
    600_000,
  );
});
