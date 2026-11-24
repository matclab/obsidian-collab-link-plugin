// @vitest-environment jsdom
// The home's identity under a controlled order (AGENTS.md §1.6; phase
// 38d, HA1 – HA5): the configuration read, the attestation and the
// sign-in opened, the account's state changing, each attestation and each
// decision answered in any order, the list stored here opened, a recent
// sign-in asked to confirm, the home closed: each when Hegel says. The
// attestor, the revocations, signing in and the situation are fakes that
// count what is asked of them; the list here is Ada's account list.
//
// At every step: closed, nothing more opened, all closed (HA1); the
// step shown comes from the latest attestation asked when it answered
// (HA2); only the latest decision goes on to ask anything more (HA3); a
// situation asked only once the list here is open (HA4); confirming, the
// identity stays the one signed in (HA5).
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test, vi } from "vitest";
import type { AttestorState } from "../account/attestor.js";
import type { AccountState } from "../account/sign-in.js";
import { setLanguage } from "../i18n/index.js";
import type { KeyringEnvironment } from "./environment.js";
import { type IdentityStep, followHomeAccount } from "./home-account.js";
import type { HomeCore, HomeScreen } from "./home.js";
import type { KeyringSession } from "./session.js";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const fakes = vi.hoisted(() => ({
  /** Each open, answered when Hegel says. */
  config: undefined as undefined | ((config: object) => void),
  attestorOpen: undefined as undefined | ((attestor: object) => void),
  signInOpen: undefined as undefined | ((signIn: object) => void),
  /** What the home gave signing in: its `onChange`. */
  signInOptions: undefined as undefined | { onChange(state: unknown): void },
  /** Each situation asked, and whether the list here was open then. */
  situations: [] as {
    answer: (found: object) => void;
    loaded: boolean;
    answered: boolean;
  }[],
  revocationsClosed: 0,
  revocationsMade: 0,
}));
vi.mock("../account/config.js", () => ({
  readPageConfig: () =>
    new Promise((resolve) => {
      fakes.config = resolve;
    }),
}));
vi.mock("../account/attestor.js", () => ({
  Attestor: {
    open: () =>
      new Promise((resolve) => {
        fakes.attestorOpen = resolve;
      }),
  },
}));
vi.mock("../account/revocations.js", () => ({
  RevocationReader: class {
    constructor() {
      fakes.revocationsMade += 1;
    }
    subscribe() {
      return () => {};
    }
    async read() {}
    close() {
      fakes.revocationsClosed += 1;
    }
  },
}));
vi.mock("../account/sign-in.js", () => ({
  SignIn: {
    open: (options: { onChange(state: unknown): void }) =>
      new Promise((resolve) => {
        fakes.signInOptions = options;
        fakes.signInOpen = resolve;
      }),
  },
}));
vi.mock("./association.js", () => ({
  situation: () =>
    new Promise((resolve) => {
      fakes.situations.push({
        answer: resolve,
        loaded: loadedNow(),
        answered: false,
      });
    }),
  associate: async () => undefined,
  associationKey: () => new Uint8Array(32),
}));
/** Whether the list here is open, as the fake situation reads it. */
let loadedNow = () => false;

type TC = Parameters<Parameters<typeof hegel.testAsync>[0]>[0];

const quiet = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const GATEWAY = "https://accounts.example";
const ADA: AccountState = {
  kind: "signed-in",
  name: "Ada",
  email: null,
  issuer: "i",
  sub: "s",
};
const GRACE: AccountState = {
  kind: "signed-in",
  name: "Grace",
  email: null,
  issuer: "i",
  sub: "t",
};
const STATES: AccountState[] = [
  ADA,
  GRACE,
  { kind: "signed-out", ready: true },
  { kind: "pending" },
];
const ANSWERS: AttestorState[] = [
  "attested",
  "unattested",
  "needs-recent",
  "refused",
];
const SITUATIONS = [
  { kind: "associated" },
  { kind: "open-here" },
  { kind: "ask", count: 1, titles: ["a"] },
  { kind: "other", count: 1, titles: ["b"], identity: { sub: "u" } },
];
const STEPS: Record<AttestorState, IdentityStep | undefined> = {
  attested: undefined,
  unattested: "unconfirmed",
  "needs-recent": "confirm",
  refused: "refused",
};

const accountScenario = async (tc: TC): Promise<void> => {
  setLanguage("en");
  fakes.config = undefined;
  fakes.attestorOpen = undefined;
  fakes.signInOpen = undefined;
  fakes.signInOptions = undefined;
  fakes.situations.length = 0;
  fakes.revocationsClosed = 0;
  fakes.revocationsMade = 0;

  /** What the decisions went on to ask: whether the decision answered
   * last was the latest asked (HA3). */
  const asks: boolean[] = [];
  let answering = 0;
  const ask = () => asks.push(answering === fakes.situations.length - 1);
  const env = {
    fetch: async () => new Response("{}"),
    setTimer: () => () => {},
    local: { forget: async () => {} },
    account: {
      local: {
        associationLater: async () => {
          ask();
          return false;
        },
        identityName: async () => {
          ask();
          return undefined;
        },
        keepIdentityName: async () => {
          ask();
        },
        keepAssociationLater: async () => {},
      },
      openWindow: () => {},
      channel: () => ({}),
    },
  } as unknown as KeyringEnvironment;
  const session = {
    ref: { gateway: GATEWAY, issuer: "i", sub: "s", key: new Uint8Array(32) },
    sync: async () => "synced",
  } as unknown as KeyringSession;

  const steps: (IdentityStep | undefined)[] = [];
  const screen = {
    setAccountList: () => {},
    setIdentityStep: (step: IdentityStep | undefined) => steps.push(step),
    setOrg: () => {},
    setAccount: () => {},
    setAccountKeyError: () => {},
    setNewSigningKeyOffline: () => {},
    reveal: () => {},
  } as unknown as HomeScreen;
  const loaded = deferred<void>();
  let loadedIn = false;
  loadedNow = () => loadedIn;
  let closed = false;
  const core: HomeCore = {
    options: {
      apiBase: "https://collab.test",
      keyring: env,
      createKeyring: async () => {
        throw new Error("not here");
      },
      confirm: () => true,
      copy: async () => {},
      now: () => 0,
    },
    keys: {} as HomeCore["keys"],
    screen: () => screen,
    session: () => session,
    use: () => {},
    leave: () => {},
    say: () => {},
    onStatus: () => {},
    showingStatus: () => false,
    busy: (work) => work(),
    takenMeanwhile: async () => {},
    closed: () => closed,
    loaded: loaded.promise,
  };
  const account = followHomeAccount(core, {
    signedIn: () => {},
    endPairing: () => {},
  });

  // The fakes opened, and what they were asked.
  const refreshes: {
    answer: (found: AttestorState) => void;
    answered: boolean;
  }[] = [];
  let attestorClosed = 0;
  let attestorMade = false;
  let signInClosed = 0;
  let signInMade = false;
  let state: AccountState = ADA;
  const withAttestation =
    tc.draw(gs.integers({ minValue: 0, maxValue: 3 })) > 0;
  void account.start();
  await quiet();

  /** The model: the attestation answered last while it was the latest,
   * reset as the identity changes (HA2); the identity signed in, kept
   * while confirming (HA5); the key asked for (`open-here`). */
  let attested: AttestorState | undefined;
  let confirming = false;
  let signedSub: string | undefined;
  let needsKey = false;
  let gateway = false;
  let signInOpen = false;
  /** The account told of `next`, as `onAccount` takes it. */
  const told = (next: AccountState) => {
    if (confirming && next.kind === "pending") return;
    confirming = false;
    const sub = gateway && next.kind === "signed-in" ? next.sub : undefined;
    if (sub !== signedSub) {
      needsKey = false;
      attested = undefined;
    }
    signedSub = sub;
  };

  // What changes and answers, twice as often: several attestations and
  // decisions in flight, answered out of order (HA2, HA3).
  /** The account's state, told as signing in tells it. */
  const change = (next: AccountState) => {
    state = next;
    told(next);
    (
      fakes.signInOptions as { onChange(state: unknown): void } | undefined
    )?.onChange(next);
  };
  const moves = [
    "config",
    "attestor",
    "sign-in",
    "state",
    "away-and-back",
    "attestation",
    "attestation",
    "situation",
    "situation",
    "loaded",
    "confirm",
    "close",
  ] as const;
  type Move = (typeof moves)[number];
  // Often, all opened first, as a network that answers at once.
  const opening: Move[] = tc.draw(gs.booleans())
    ? ["config", "attestor", "sign-in", "loaded"]
    : [];
  const count =
    opening.length + tc.draw(gs.integers({ minValue: 1, maxValue: 30 }));
  for (let step = 0; step < count; step++) {
    const move = opening.shift() ?? tc.draw(gs.sampledFrom([...moves]));
    switch (move) {
      case "config": {
        const answer = fakes.config as ((config: object) => void) | undefined;
        if (!answer) break;
        fakes.config = undefined;
        if (!closed) gateway = true;
        answer({
          gateway: GATEWAY,
          ...(withAttestation && { attestationKeys: ["k"] }),
        });
        break;
      }
      case "attestor": {
        const answer = fakes.attestorOpen as
          | ((attestor: object) => void)
          | undefined;
        if (!answer) break;
        fakes.attestorOpen = undefined;
        attestorMade = true;
        answer({
          refresh: () =>
            new Promise<AttestorState>((resolve) => {
              const index = refreshes.length;
              refreshes.push({
                answered: false,
                answer: (found) => {
                  // Latest when it answers (HA2).
                  if (index === refreshes.length - 1 && !closed) {
                    attested = found;
                  }
                  resolve(found);
                },
              });
            }),
          refusedKey: () => undefined,
          wantsRecent: () => false,
          close: () => {
            attestorClosed += 1;
          },
        });
        break;
      }
      case "sign-in": {
        const answer = fakes.signInOpen as
          | ((signIn: object) => void)
          | undefined;
        if (!answer) break;
        signInMade = true;
        fakes.signInOpen = undefined;
        if (!closed) {
          signInOpen = true;
          told(state);
        }
        answer({
          state: () => state,
          start: () => {},
          cancel: () => {},
          signOut: async () => {},
          recent: () => false,
          close: () => {
            signInClosed += 1;
          },
        });
        break;
      }
      case "state": {
        // Signing in tells of a change only while it is open.
        if (!signInOpen || closed) break;
        change(tc.draw(gs.sampledFrom(STATES)));
        break;
      }
      case "away-and-back":
        // One gesture: signed in as another, then as Ada again — two
        // attestations and two decisions in flight (HA2, HA3).
        if (!signInOpen || closed) break;
        change(GRACE);
        change(ADA);
        break;
      case "attestation": {
        // Each answered once, in any order.
        const waiting = refreshes.filter((asked) => !asked.answered);
        if (waiting.length === 0) break;
        const at = tc.draw(
          gs.integers({ minValue: 0, maxValue: waiting.length - 1 }),
        );
        const asked = waiting[at];
        if (!asked) break;
        asked.answered = true;
        asked.answer(tc.draw(gs.sampledFrom(ANSWERS)));
        break;
      }
      case "situation": {
        // Each answered once, in any order.
        const waiting = fakes.situations.filter((asked) => !asked.answered);
        if (waiting.length === 0) break;
        const picked =
          waiting[
            tc.draw(gs.integers({ minValue: 0, maxValue: waiting.length - 1 }))
          ];
        if (!picked) break;
        picked.answered = true;
        const at = fakes.situations.indexOf(picked);
        const found = tc.draw(gs.sampledFrom(SITUATIONS));
        answering = at;
        if (
          found.kind === "open-here" &&
          at === fakes.situations.length - 1 &&
          !closed
        ) {
          needsKey = true;
        }
        picked.answer(found);
        break;
      }
      case "loaded":
        loadedIn = true;
        loaded.resolve();
        break;
      case "confirm":
        // As the component's « Confirmer », signed in.
        if (signInOpen && !closed && state.kind === "signed-in") {
          confirming = true;
        }
        account.props.onConfirmIdentity();
        break;
      case "close":
        if (closed) break;
        closed = true;
        account.close();
        break;
    }
    await quiet();

    // HA1: closed, all that was opened closed (twice at most: by the home
    // and as what it waited for came, `close` doing nothing the second
    // time); nothing before.
    if (closed) {
      expect(attestorClosed > 0).toBe(attestorMade);
      expect(signInClosed > 0).toBe(signInMade);
      expect(fakes.revocationsClosed > 0).toBe(fakes.revocationsMade > 0);
      for (const times of [
        attestorClosed,
        signInClosed,
        fakes.revocationsClosed,
      ]) {
        expect(times).toBeLessThanOrEqual(2);
      }
    } else {
      expect(attestorClosed + signInClosed + fakes.revocationsClosed).toBe(0);
    }
    // HA4: a situation asked only once the list here is open.
    for (const asked of fakes.situations) expect(asked.loaded).toBe(true);
    // HA3: only the latest decision goes on to ask more.
    expect(asks.every(Boolean)).toBe(true);
    if (closed) continue;
    // HA5: confirming, the identity stays the one signed in.
    expect(account.signed()?.sub).toBe(signedSub);
    // HA2: the step shown, Ada's list hers and no key asked for.
    if (steps.length > 0) {
      expect(steps.at(-1)).toBe(
        signedSub === "s" && !needsKey && attested
          ? STEPS[attested]
          : undefined,
      );
    }
  }
};

describe("the home's identity under a controlled order", () => {
  test(
    "HA1 – HA5 at every step, whatever the order",
    () => hegel.testAsync(accountScenario, { testCases: 400 }),
    600_000,
  );
});
