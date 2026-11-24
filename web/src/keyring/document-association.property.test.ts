// @vitest-environment node
//
// The association with the identity after a sign-in, across two tabs of
// one device (docs/phase-18-trousseau-identite.md, analysis 18o.2,
// interleavings 1 and 2; KR-44; TR1; AGENTS.md §1.6). The device holds a
// list by link, empty or not; the identity has none yet. Every source of
// order is a choice of the test: when each tab sees the sign-in, when a
// tab adds a document to the list (before, during or after the
// association), when the server and the gateway take each request, when
// each encryption and decryption ends (`cryptoGate`), when each write to
// the device's copy ends, when each timer fires.
// At each step, and at the end once everything has run: every document a
// tab was promised (a write resolved « saved ») is in the device's copy,
// and, after a last sync, in the list the device holds on its server or
// gateway; the device's list is associated once — every tab ends on the
// same list, under the same key, which opens what the gateway holds; a
// list that held documents before the sign-in is never associated without
// a question; an empty one, with nothing added, always is.
// Analysis 18p.2: the device may hold no list at all, the identity one
// at the gateway or none; each tab's document opened when the test says
// (its hooks, as a view calls them). Every document opened ends in the
// device's list (LA2); the identity's list elsewhere, one list in waiting,
// by link, kept on the server, every other keyring made for it deleted
// (LA1).
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc } from "loro-crdt";
import { describe, expect, test, vi } from "vitest";
import {
  type KeyringCredentials,
  createKeyring,
  decryptKeyring,
  listKeyring,
  newKeyringDoc,
  readKeyringPlaintext,
  rememberLink,
} from "../../lib/src/index.js";
import { FakeKeyringServer } from "../../lib/src/keyring/test-support/fake-keyring-server.js";
import { testLink } from "../../lib/src/keyring/test-support/links.js";
import { cryptoGate } from "../../lib/src/transport/test-support/crypto-gate.js";
import type { AccountState } from "../account/sign-in.js";
import { FakeGateway } from "../account/test-support.js";
import {
  DocumentAssociation,
  type DocumentSituation,
} from "./document-association.js";
import { type KeyringEnvironment, sessionOptions } from "./environment.js";
import { type DocumentKeyring, documentKeyring } from "./hooks.js";
import type {
  AccountLocal,
  KeyringLocal,
  SignedIn,
  StoredKeyring,
} from "./local.js";
import {
  type KeyringRef,
  formatKeyringRef,
  isAccountKeyring,
  sameKeyring,
} from "./ref.js";
import { KeyringSession } from "./session.js";

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

const ORIGIN = "https://collab.test";
const ISSUER = "https://idp.example";
const SUB = "u-1";

/** The device's copy (local.ts's contract, in memory, as in
 * `session.property.test.ts`): one write at a time (the lock), each
 * landing when the test says. What waits for its turn runs nothing. */
class DeviceCopy {
  stored: { ref: KeyringRef; snapshot: Uint8Array } | undefined;
  retiredLinks: KeyringCredentials[] = [];
  /** Which keyring replaced which here (RA2): an identifier to the next
   * list's own (the scenario's lists are links, or the one account). */
  replaced = new Map<string, string>();
  account: SignedIn | undefined;
  /** Writes whose turn came, waiting to land. */
  readonly landing: (() => void)[] = [];
  private tail: Promise<unknown> = Promise.resolve();

  private turn<T>(work: () => T): Promise<T> {
    const run = this.tail.then(
      () =>
        new Promise<T>((resolve, reject) =>
          this.landing.push(() => {
            try {
              resolve(work());
            } catch (error) {
              reject(error);
            }
          }),
        ),
    );
    this.tail = run.catch(() => {});
    return run;
  }

  /** `doc` with the stored copy merged in, then stored under `ref`. */
  private keep(ref: KeyringRef, doc: LoroDoc, merge: boolean): void {
    if (merge && this.stored) doc.import(this.stored.snapshot);
    this.stored = { ref, snapshot: doc.export({ mode: "snapshot" }) };
  }

  local(): KeyringLocal & AccountLocal {
    return {
      load: async (): Promise<StoredKeyring | undefined> => {
        if (!this.stored) return undefined;
        const doc = new LoroDoc();
        doc.import(this.stored.snapshot);
        return { ref: this.stored.ref, doc };
      },
      save: (ref, doc) =>
        this.turn(() => {
          if (this.stored && !sameKeyring(this.stored.ref, ref))
            return "superseded" as const;
          this.keep(ref, doc, true);
          return "saved" as const;
        }),
      replace: (ref, doc) => this.turn(() => this.keep(ref, doc, false)),
      claim: (ref, doc) =>
        this.turn(() => {
          if (this.stored && !sameKeyring(this.stored.ref, ref))
            return "taken" as const;
          this.keep(ref, doc, false);
          return "claimed" as const;
        }),
      join: async () => {
        throw new Error("not in this scenario");
      },
      forget: (ref) =>
        this.turn(() => {
          if (this.stored && sameKeyring(this.stored.ref, ref))
            this.stored = undefined;
        }),
      // As local.ts: the stored list is the old one or already the next,
      // merged in; another one, nothing written.
      rotate: (next, doc, old, options) =>
        this.turn(() => {
          const here = this.stored?.ref;
          if (here && !sameKeyring(here, old) && !sameKeyring(here, next))
            return "taken" as const;
          // RA1: decided on the copy, under the lock.
          if (options?.onlyIfEmpty && this.stored) {
            const copy = new LoroDoc();
            copy.import(this.stored.snapshot);
            if (listKeyring(copy).length > 0) return "not-empty" as const;
          }
          if (this.stored) doc.import(this.stored.snapshot);
          this.keep(next, doc, false);
          this.replaced.set(
            old.keyringId,
            isAccountKeyring(next) ? "account" : next.keyringId,
          );
          const link = formatKeyringRef(old);
          this.retiredLinks = [
            ...this.retiredLinks.filter((l) => formatKeyringRef(l) !== link),
            old,
          ];
          return "rotated" as const;
        }),
      retired: async () => [...this.retiredLinks],
      successor: async (ref) => {
        if (isAccountKeyring(ref) || !this.stored) return undefined;
        const here = this.stored.ref;
        if (sameKeyring(here, ref)) return undefined;
        const target = isAccountKeyring(here) ? "account" : here.keyringId;
        let at: string | undefined = ref.keyringId;
        while (at !== undefined && at !== target) at = this.replaced.get(at);
        if (at !== target) return undefined;
        const doc = new LoroDoc();
        doc.import(this.stored.snapshot);
        return { ref: this.stored.ref, doc };
      },
      // Starting over (analysis 18p.3) is the home's, not a document's.
      startOver: async () => "taken" as const,
      startingOver: async () => false,
      clearStartOver: async () => {},
      clearRetired: (old) =>
        this.turn(() => {
          this.retiredLinks = this.retiredLinks.filter(
            (l) => formatKeyringRef(l) !== formatKeyringRef(old),
          );
        }),
      signedIn: async () => this.account,
      keepSignedIn: async (account) => {
        this.account = account;
      },
      forgetSignedIn: async (token) => {
        if (this.account?.token === token) this.account = undefined;
      },
      attestation: async () => undefined,
      keepAttestation: async () => {},
      refusedKey: async () => undefined,
      keepRefusedKey: async () => {},
      associationLater: async () => false,
      keepAssociationLater: async () => {},
      identityName: async () => undefined,
      keepIdentityName: async () => {},
    };
  }
}

/** The sign-in, as one tab sees it. */
class Gate {
  private current: AccountState = { kind: "signed-out", ready: true };
  private readonly listeners = new Set<() => void>();
  state = () => this.current;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  signIn() {
    this.current = {
      kind: "signed-in",
      name: "Ada",
      email: null,
      issuer: ISSUER,
      sub: SUB,
    };
    for (const listener of [...this.listeners]) listener();
  }
}

interface Tab {
  gate: Gate;
  association: DocumentAssociation;
  session: () => Promise<KeyringSession | undefined>;
  /** Its document's hooks (LA2), and the document. */
  hooks: DocumentKeyring;
  documentId: string;
}

/** A server's answer, its body read: as much of a `Response` as the
 * keyring's transport reads, at once. */
async function answered(response: Response): Promise<Response> {
  const body = new Uint8Array(await response.arrayBuffer());
  return {
    status: response.status,
    ok: response.ok,
    headers: response.headers,
    arrayBuffer: async () => body.slice().buffer,
    json: async () => JSON.parse(new TextDecoder().decode(body)),
    text: async () => new TextDecoder().decode(body),
  } as unknown as Response;
}

/** The documents a list holds. */
const documentsOf = (doc: LoroDoc | null | undefined) =>
  new Set(doc ? listKeyring(doc).map((entry) => entry.documentId) : []);

/** One scenario of the association, each source of order drawn from
 * `tc`: the property's body, and a counter-example's replay. */
const associationScenario = async (tc: TC): Promise<void> => {
  const server = new FakeKeyringServer();
  const gateway = new FakeGateway();
  const pending: { label: string; run: () => void }[] = [];
  const timers: { run: () => void; live: boolean }[] = [];
  let alone = false;
  /** Requests the server takes, their bodies read: counted. */
  let reading = 0;
  /** A keyring being made, before or after its request: counted. */
  let making = 0;
  const copy = new DeviceCopy();
  const local = copy.local();
  const env: KeyringEnvironment = {
    local,
    // Every request waits for the test.
    fetch: (url, init) =>
      new Promise<Response>((resolve, reject) => {
        const to = new URL(url).origin === gateway.origin ? gateway : server;
        pending.push({
          label: `${init?.method ?? "GET"} ${new URL(url).pathname}`,
          // Taken by the server, and its answer read whole: then
          // the client has it in one step (a body read from a
          // stream ends when it ends).
          run: () => {
            reading += 1;
            void to
              .fetch(url, init)
              .then(answered)
              .then(resolve, reject)
              .finally(() => {
                reading -= 1;
              });
          },
        });
      }),
    setTimer: (run) => {
      // The last syncs: nothing chosen any more, a wait ends.
      if (alone) {
        const at = setTimeout(run, 0);
        return () => clearTimeout(at);
      }
      const timer = { run, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    account: {
      local,
      openWindow: () => {},
      channel: () => ({ post: () => {}, listen: () => () => {} }),
    },
  };

  // The device's list by link, empty or holding a document, kept
  // here and on the server; the account signed in on the device.
  cryptoGate.stop();
  // No list here (18p.2), or one by link, empty or not.
  const start = tc.draw(gs.integers({ minValue: 0, maxValue: 2 }));
  const nothingHere = start === 0;
  const held = start === 2;
  // With no list here, the identity's may be elsewhere (LA1).
  const elsewhere = nothingHere && tc.draw(gs.booleans());
  if (elsewhere) {
    gateway.keyrings.set(SUB, {
      version: 1,
      blob: crypto.getRandomValues(new Uint8Array(64)),
    });
  }
  if (!nothingHere) {
    const created = await createKeyring(ORIGIN, server.fetch);
    const first = newKeyringDoc();
    if (held) {
      rememberLink(first, testLink("before", "edit"), { at: 1 });
    }
    const claimed = local.claim(created, first);
    // Its turn comes in a microtask.
    while (copy.landing.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    copy.landing.shift()?.();
    await claimed;
  }
  await local.keepSignedIn({
    gateway: gateway.origin,
    token: gateway.tokenOf(SUB),
    deadline: Date.now() + 3_600_000,
    name: "Ada",
    email: null,
    issuer: ISSUER,
    sub: SUB,
  });
  cryptoGate.start();
  /** Nothing runs that the test doesn't hold: WebCrypto, counted,
   * then a turn for the microtasks after it (AGENTS.md §1.6). */
  const quiet = async () => {
    const busy = () => cryptoGate.running > 0 || reading > 0 || making > 0;
    do {
      while (busy()) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      await new Promise((resolve) => setImmediate(resolve));
    } while (busy());
  };

  /** `createKeyring`, its verifier's hashing counted (`quiet`),
   * its request the test's. */
  const makeKeyring = async () => {
    making += 1;
    try {
      return await createKeyring(ORIGIN, async (url, init) => {
        making -= 1;
        try {
          return await env.fetch(url, init);
        } finally {
          making += 1;
        }
      });
    } finally {
      making -= 1;
    }
  };
  const tabs: Tab[] = [0, 1].map((i) => {
    let current = KeyringSession.open(sessionOptions(env, ORIGIN));
    const documentId = `tab-${i}`;
    const hooks = documentKeyring(() => current, documentId, {
      created: true,
      now: () => 10,
    });
    const gate = new Gate();
    const association = new DocumentAssociation({
      env,
      apiBase: ORIGIN,
      gateway: gateway.origin,
      gate,
      session: () => current,
      // As `documentIdentity` does (LA2).
      replace: (next) => {
        current = Promise.resolve(next);
        void hooks.again();
      },
      refresh: async () => {},
      createKeyring: makeKeyring,
    });
    return {
      gate,
      association,
      session: () => current,
      hooks,
      documentId,
    };
  });
  await quiet();
  /** Documents whose write resolved « saved », and when. */
  const promised = new Set<string>();
  /** Whether a document was promised before a tab saw the sign-in. */
  let promisedBeforeSignIn = held;
  let signedIn = false;
  let added = 0;
  /** The tabs whose document was opened (LA2). */
  const opened = new Set<string>();
  const add = (t: Tab) => {
    const name = `doc-${added++}`;
    void t
      .session()
      .then((session) =>
        session?.change(
          (doc) =>
            void rememberLink(doc, testLink(name, "edit"), {
              at: added,
            }),
        ),
      )
      .then((outcome) => {
        if (outcome !== "saved") return;
        promised.add(name);
        if (!signedIn) promisedBeforeSignIn = true;
      });
  };

  const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 30 }));
  for (let step = 0; step < steps; step++) {
    const tab = tabs[tc.draw(gs.integers({ minValue: 0, maxValue: 1 }))] as Tab;
    switch (tc.draw(gs.integers({ minValue: 0, maxValue: 6 }))) {
      case 0:
        signedIn = true;
        if (tab.gate.state().kind !== "signed-in") tab.gate.signIn();
        break;
      case 1:
        // Its document opened, once; a list without one, as
        // before (a document added).
        if (nothingHere && !opened.has(tab.documentId)) {
          opened.add(tab.documentId);
          void tab.hooks.opened(testLink(tab.documentId, "edit"));
        } else if (added < 4) add(tab);
        break;
      case 2:
      case 3:
        if (pending.length > 0) {
          const at = tc.draw(
            gs.integers({ minValue: 0, maxValue: pending.length - 1 }),
          );
          pending.splice(at, 1)[0]?.run();
        }
        break;
      case 4:
        if (tc.draw(gs.booleans())) {
          if (cryptoGate.held.length > 0) {
            const at = tc.draw(
              gs.integers({
                minValue: 0,
                maxValue: cryptoGate.held.length - 1,
              }),
            );
            cryptoGate.release(
              cryptoGate.held[at] as (typeof cryptoGate.held)[number],
            );
          }
        } else copy.landing.shift()?.();
        break;
      default: {
        const live = timers.filter((timer) => timer.live);
        if (live.length > 0) {
          const timer = live[
            tc.draw(gs.integers({ minValue: 0, maxValue: live.length - 1 }))
          ] as (typeof live)[number];
          timer.live = false;
          timer.run();
        }
      }
    }
    await quiet();
  }
  // The end: both tabs see the sign-in; everything held runs, in
  // order, until nothing is left.
  signedIn = true;
  for (const t of tabs) {
    if (t.gate.state().kind !== "signed-in") t.gate.signIn();
  }
  for (let round = 0; round < 400; round++) {
    await quiet();
    const request = pending.shift();
    if (request) {
      request.run();
      continue;
    }
    const result = cryptoGate.held[0];
    if (result) {
      cryptoGate.release(result);
      continue;
    }
    const write = copy.landing.shift();
    if (write) {
      write();
      continue;
    }
    const timer = timers.find((t) => t.live);
    if (!timer) break;
    timer.live = false;
    timer.run();
  }
  // Settled, then the gates down: a last sync of each tab, alone.
  await Promise.all(tabs.map((t) => t.association.settled()));
  cryptoGate.stop();
  alone = true;
  const runAll = async () => {
    for (let round = 0; round < 200; round++) {
      const next = pending.shift() ?? copy.landing.shift();
      if (!next) return;
      if (typeof next === "function") next();
      else next.run();
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  /** `work`, everything it asks run, until it ends. */
  const finish = async <T>(work: Promise<T>): Promise<T> => {
    let done = false;
    void work.finally(() => {
      done = true;
    });
    for (let round = 0; !done; round++) {
      if (round > 10_000) throw new Error("a last sync never ends");
      await runAll();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return work;
  };
  const finals: KeyringSession[] = [];
  for (const t of tabs) {
    const session = await t.session();
    if (!session) throw new Error("a tab without its list");
    await finish(session.sync());
    finals.push(session);
  }
  for (const timer of timers) timer.live = false;
  // One list for the device: every tab on it, under one key.
  const [a, b] = finals as [KeyringSession, KeyringSession];
  const stored = await local.load();
  if (!stored) throw new Error("no list on the device");
  for (const session of finals) {
    expect(sameKeyring(session.ref, stored.ref)).toBe(true);
    expect(session.ref.key).toEqual(stored.ref.key);
  }
  expect(sameKeyring(a.ref, b.ref)).toBe(true);

  // TR1: what was promised is in the device's copy, and where the
  // list is kept.
  const here = documentsOf(stored.doc);
  for (const name of promised) expect(here.has(name)).toBe(true);
  if (held) expect(here.has("before")).toBe(true);
  let remote: LoroDoc | null;
  if (isAccountKeyring(stored.ref)) {
    const { blob } = gateway.keyringOf(SUB);
    remote = readKeyringPlaintext(await decryptKeyring(stored.ref.key, blob));
  } else {
    const kept = server.keyrings.get(stored.ref.keyringId);
    remote = kept
      ? readKeyringPlaintext(await decryptKeyring(stored.ref.key, kept.blob))
      : null;
  }
  const there = documentsOf(remote);
  for (const name of promised) expect(there.has(name)).toBe(true);

  // Associated without a question only if nothing was in the list
  // when it was decided: never when a document was promised before
  // the sign-in; always when nothing was ever added.
  const situations = tabs.map(
    (t) => t.association.situation().kind,
  ) as DocumentSituation["kind"][];
  // LA2: every document opened is in the device's list, and where
  // it is kept.
  for (const name of opened) {
    expect(here.has(name)).toBe(true);
    expect(there.has(name)).toBe(true);
  }
  if (nothingHere) {
    if (elsewhere) {
      // LA1: one list in waiting, by link; the identity's
      // untouched; every other keyring made for it deleted.
      expect(isAccountKeyring(stored.ref)).toBe(false);
      expect(gateway.keyringOf(SUB).version).toBe(1);
      expect(server.keyrings.size).toBe(1);
      expect(situations).toEqual(["open-here", "open-here"]);
    } else {
      expect(isAccountKeyring(stored.ref)).toBe(true);
      expect(situations).toEqual(["associated", "associated"]);
    }
  } else if (promisedBeforeSignIn) {
    expect(isAccountKeyring(stored.ref)).toBe(false);
    expect(gateway.keyringOf(SUB).version).toBe(0);
    expect(situations).toEqual(["ask", "ask"]);
  } else if (added === 0) {
    expect(isAccountKeyring(stored.ref)).toBe(true);
    expect(situations).toEqual(["associated", "associated"]);
  }
  for (const t of tabs) t.association.close();
  for (const session of finals) session.close();
};

/** A `tc` that gives back recorded draws, in order (Hegel prints them as
 * `draw_1`, `draw_2`… when a case fails); `done` says whether all were
 * taken. */
function replay(draws: readonly (number | boolean)[]) {
  let next = 0;
  const tc = {
    draw: () => {
      if (next >= draws.length) throw new Error("more draws than recorded");
      return draws[next++];
    },
  } as unknown as TC;
  return { tc, done: () => next === draws.length };
}

describe("the association across tabs (analysis 18o.2, cases 1 and 2)", () => {
  test(
    "nothing promised is lost, the list associated once, never a list that held documents",
    () => hegel.testAsync(associationScenario, { testCases: 150 }),
    240_000,
  );

  // Found on 2026-10-23 (phase 19a.1, without relation to it; red at
  // 42550d7c too), the case Hegel shrank to, kept here rather than only
  // in web/.hegel/examples: a list by link, empty; tab 0 sees the
  // sign-in, a request runs, tab 1 sees the sign-in, a request runs,
  // tab 0 adds a document. At the end, a tab held a list other than the
  // device's: RA1 judged the copy merged into the tab's view, the tab's own
  // document waiting for the lock refused the association (corrected
  // 2026-10-28: the copy stored alone).
  test("a counter-example kept: an empty list by link, both tabs signed in, then a document added", async () => {
    const { tc, done } = replay([1, 5, 0, 0, 0, 2, 0, 1, 0, 0, 2, 0, 0, 1]);
    await associationScenario(tc);
    expect(done()).toBe(true);
  }, 60_000);

  // Found on 2026-10-30 (phase 20, without relation to it), once the
  // examples of web/.hegel were emptied: an empty list by link; tab 0
  // sees the sign-in, associates and syncs the list; tab 1, which wrote
  // nothing since, sees the sign-in last. At the end, it held a list
  // other than the device's: it judged on the list replaced, and the
  // identity, its list at the gateway, seemed to have one elsewhere
  // (« open-here »). Corrected the same day: a tab judges on the list
  // that replaced its own (analysis 18p, RA3).
  test("a second counter-example kept: a tab holds another list than the device's", async () => {
    const { tc, done } = replay([
      1,
      8,
      0,
      0,
      0,
      2,
      0,
      0,
      4,
      false,
      0,
      5,
      1,
      0,
      0,
      0,
      2,
      0,
      0,
      0,
      0,
      4,
      true,
      0,
    ]);
    await associationScenario(tc);
    expect(done()).toBe(true);
  }, 60_000);
});
