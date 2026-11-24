// The identity and « Mes documents » from a document (analysis 18o.2): a
// sign-in made in the document — decision 20's question — associates the
// device's list as the home page does, when there is nothing to decide;
// what is being signed waits for it (`settled`); two tabs of the device
// associating at once lose nothing (case 1, TR1). On fake-indexeddb, a
// keyring server and a gateway in memory.
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, onTestFinished, test } from "vitest";
import {
  createKeyring,
  decryptKeyring,
  listKeyring,
  readKeyringPlaintext,
  rememberLink,
} from "../../lib/src/index.js";
import { FakeKeyringServer } from "../../lib/src/keyring/test-support/fake-keyring-server.js";
import { testLink } from "../../lib/src/keyring/test-support/links.js";
import { ActivityCount } from "../../lib/src/transport/test-support/activity-count.js";
import type { AccountState } from "../account/sign-in.js";
import { FakeGateway } from "../account/test-support.js";
import { DocumentAssociation } from "./document-association.js";
import { type KeyringEnvironment, sessionOptions } from "./environment.js";
import { type KeyringLock, openKeyringLocal } from "./local.js";
import { isAccountKeyring } from "./ref.js";
import { KeyringSession } from "./session.js";

const ORIGIN = "https://collab.test";
const ISSUER = "https://idp.example";

function memoryLock(): KeyringLock {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    exclusive(_name, run) {
      const result = tail.then(run, run);
      tail = result.catch(() => {});
      return result;
    },
  };
}

/** The sign-in of a page, as the test drives it. */
class Gate {
  private current: AccountState = { kind: "signed-out", ready: true };
  private readonly listeners = new Set<() => void>();
  state = () => this.current;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  set(state: AccountState) {
    this.current = state;
    for (const listener of [...this.listeners]) listener();
  }
}

const signedIn = (sub: string): AccountState => ({
  kind: "signed-in",
  name: sub,
  email: null,
  issuer: ISSUER,
  sub,
});

/** What the tabs of a test have in progress (AGENTS.md §1.6): their
 * requests, their stores, their timers, WebCrypto. */
let activity = new ActivityCount();
beforeEach(() => {
  activity = new ActivityCount();
  onTestFinished(activity.countCrypto());
});

function device(
  server: FakeKeyringServer,
  gateway: FakeGateway,
  reachable = () => true,
) {
  const local = activity.methods(
    openKeyringLocal({
      indexedDB: new IDBFactory(),
      lock: memoryLock(),
    }),
  );
  const env: KeyringEnvironment = {
    local,
    fetch: activity.counted(async (url: string, init?: RequestInit) => {
      if (new URL(url).origin !== gateway.origin)
        return server.fetch(url, init);
      if (!reachable()) throw new TypeError("out of reach");
      return gateway.fetch(url, init);
    }),
    setTimer: (run, ms) => {
      if (ms >= 60_000) return () => {};
      return activity.timers((go, after) => {
        const timer = setTimeout(go, Math.min(after, 5));
        return () => clearTimeout(timer);
      })(run, ms);
    },
    account: { local, openWindow: () => {}, channel: () => ({}) as never },
  };
  return { env, local };
}

/** A tab of the document on `env`: its session, held as the page does. */
async function tab(
  env: KeyringEnvironment,
  gateway: FakeGateway,
  gate: Gate,
  server?: FakeKeyringServer,
) {
  let current = KeyringSession.open(sessionOptions(env, ORIGIN));
  const refreshed: string[] = [];
  const association = new DocumentAssociation({
    env,
    apiBase: ORIGIN,
    gateway: gateway.origin,
    gate,
    session: () => current,
    replace: (next) => {
      current = Promise.resolve(next);
    },
    refresh: async () => {
      refreshed.push("refresh");
    },
    ...(server && { createKeyring: () => createKeyring(ORIGIN, server.fetch) }),
  });
  return { association, session: () => current, refreshed };
}

async function signInKept(
  local: ReturnType<typeof openKeyringLocal>,
  gateway: FakeGateway,
  sub: string,
) {
  await local.keepSignedIn({
    gateway: gateway.origin,
    token: gateway.tokenOf(sub),
    deadline: Date.now() + 3_600_000,
    name: sub,
    email: null,
    issuer: ISSUER,
    sub,
  });
}

async function onGateway(gateway: FakeGateway, sub: string, key: Uint8Array) {
  const { blob } = gateway.keyringOf(sub);
  if (blob.length === 0) return [];
  const doc = readKeyringPlaintext(await decryptKeyring(key, blob));
  return doc
    ? listKeyring(doc)
        .map((e) => e.documentId)
        .sort()
    : [];
}

/** Once nothing is in progress, `condition` holds, read once. */
async function until(condition: () => Promise<boolean>) {
  await activity.settled();
  expect(await condition()).toBe(true);
}

describe("the identity and « Mes documents » from a document", () => {
  test("signed in from the document, nothing here: associated, then the attestation asked", async () => {
    const server = new FakeKeyringServer();
    const gateway = new FakeGateway();
    const { env, local } = device(server, gateway);
    const gate = new Gate();
    const page = await tab(env, gateway, gate);
    expect(page.association.situation()).toEqual({ kind: "signed-out" });

    await signInKept(local, gateway, "u-1");
    gate.set(signedIn("u-1"));
    await page.association.settled();

    const session = await page.session();
    expect(session && isAccountKeyring(session.ref)).toBe(true);
    expect(session?.ref).toMatchObject({ sub: "u-1" });
    expect(page.association.situation()).toEqual({ kind: "associated" });
    expect(page.refreshed).toEqual(["refresh"]);
    await until(async () => gateway.keyringOf("u-1").version > 0);
  });

  test("signed in already when the document opens: associated as well", async () => {
    const server = new FakeKeyringServer();
    const gateway = new FakeGateway();
    const { env, local } = device(server, gateway);
    await signInKept(local, gateway, "u-1");
    const gate = new Gate();
    gate.set(signedIn("u-1"));

    const page = await tab(env, gateway, gate);
    await page.association.settled();

    expect((await page.session())?.ref).toMatchObject({ sub: "u-1" });
  });

  test("documents here: nothing written, the question left to the home page", async () => {
    const server = new FakeKeyringServer();
    const gateway = new FakeGateway();
    const { env, local } = device(server, gateway);
    const created = await createKeyring(ORIGIN, server.fetch);
    const own = await KeyringSession.adopt(
      sessionOptions(env, ORIGIN),
      created,
    );
    await own?.change(
      (d) => void rememberLink(d, testLink("d1", "edit"), { at: 1 }),
    );
    const gate = new Gate();
    const page = await tab(env, gateway, gate);

    await signInKept(local, gateway, "u-1");
    gate.set(signedIn("u-1"));
    await page.association.settled();

    expect(page.association.situation()).toMatchObject({
      kind: "ask",
      count: 1,
    });
    expect((await page.session())?.ref).toMatchObject({
      keyringId: created.keyringId,
    });
    expect(gateway.keyringOf("u-1").version).toBe(0);
  });

  test("case 1: two tabs of the device associate at once; one list, nothing lost", async () => {
    const server = new FakeKeyringServer();
    const gateway = new FakeGateway();
    const { env, local } = device(server, gateway);
    const gate = new Gate();
    const a = await tab(env, gateway, gate);
    const b = await tab(env, gateway, gate);

    await signInKept(local, gateway, "u-1");
    gate.set(signedIn("u-1"));
    await Promise.all([a.association.settled(), b.association.settled()]);

    const [sa, sb] = [await a.session(), await b.session()];
    expect(sa?.ref).toMatchObject({ sub: "u-1" });
    expect(sb?.ref).toMatchObject({ sub: "u-1" });
    expect(sa?.ref.key).toEqual(sb?.ref.key);
    await sb?.change(
      (d) => void rememberLink(d, testLink("d2", "edit"), { at: 2 }),
    );
    const key = sb?.ref.key as Uint8Array;
    await until(async () =>
      (await onGateway(gateway, "u-1", key)).includes("d2"),
    );
  });

  // Analysis 18p, RA3 (the second counter-example of the property): a
  // tab that wrote nothing since another associated the device's list —
  // and synced it, so the identity has a list at the gateway — judged on
  // the list replaced, « open-here », and stayed on it.
  test("RA3: the other tab associated and synced first; this one judges on the device's list", async () => {
    const server = new FakeKeyringServer();
    const gateway = new FakeGateway();
    const { env, local } = device(server, gateway);
    const created = await createKeyring(ORIGIN, server.fetch);
    await KeyringSession.adopt(sessionOptions(env, ORIGIN), created);
    const [gateA, gateB] = [new Gate(), new Gate()];
    const a = await tab(env, gateway, gateA);
    const b = await tab(env, gateway, gateB);

    await signInKept(local, gateway, "u-1");
    gateA.set(signedIn("u-1"));
    await a.association.settled();
    expect(await (await a.session())?.sync()).toBe("synced");
    expect(gateway.keyringOf("u-1").version).toBeGreaterThan(0);
    gateB.set(signedIn("u-1"));
    await b.association.settled();

    expect(b.association.situation()).toEqual({ kind: "associated" });
    const [sa, sb] = [await a.session(), await b.session()];
    expect(sb?.ref).toMatchObject({ sub: "u-1" });
    expect(sb?.ref.key).toEqual(sa?.ref.key);
  });

  // RA3, interleaving 6: this tab follows (nothing yet), then reads the
  // gateway; the other associates and syncs before the answer, which says
  // the identity has a list. Followed again, judged again.
  test("RA3: the list replaced and synced while this tab reads the gateway; judged again on the device's list", async () => {
    const server = new FakeKeyringServer();
    const gateway = new FakeGateway();
    const { env, local } = device(server, gateway);
    let held: (() => void) | undefined;
    const fetch = env.fetch;
    env.fetch = async (url, init) => {
      if (held === undefined && new URL(url).origin === gateway.origin) {
        await new Promise<void>((resolve) => {
          held = resolve;
        });
      }
      return fetch(url, init);
    };
    const created = await createKeyring(ORIGIN, server.fetch);
    await KeyringSession.adopt(sessionOptions(env, ORIGIN), created);
    const [gateA, gateB] = [new Gate(), new Gate()];
    const a = await tab(env, gateway, gateA);
    const b = await tab(env, gateway, gateB);

    await signInKept(local, gateway, "u-1");
    gateB.set(signedIn("u-1"));
    const judged = b.association.settled();
    await until(async () => held !== undefined);
    gateA.set(signedIn("u-1"));
    await a.association.settled();
    expect(await (await a.session())?.sync()).toBe("synced");
    expect(gateway.keyringOf("u-1").version).toBeGreaterThan(0);
    held?.();
    await judged;

    expect(b.association.situation()).toEqual({ kind: "associated" });
    const [sa, sb] = [await a.session(), await b.session()];
    expect(sb?.ref).toMatchObject({ sub: "u-1" });
    expect(sb?.ref.key).toEqual(sa?.ref.key);
  });

  test("the gateway out of reach: not known; tried again, associated", async () => {
    const server = new FakeKeyringServer();
    const gateway = new FakeGateway();
    let reachable = false;
    const { env, local } = device(server, gateway, () => reachable);
    const gate = new Gate();
    const page = await tab(env, gateway, gate);

    await signInKept(local, gateway, "u-1");
    gate.set(signedIn("u-1"));
    await page.association.settled();
    expect(page.association.situation()).toEqual({ kind: "unknown" });

    reachable = true;
    await page.association.retry();
    expect(page.association.situation()).toEqual({ kind: "associated" });
    expect((await page.session())?.ref).toMatchObject({ sub: "u-1" });
  });

  /** `sub`'s list at the gateway, made elsewhere: a blob this device
   * can't read. */
  const elsewhere = (gateway: FakeGateway, sub: string) =>
    gateway.keyrings.set(sub, {
      version: 1,
      blob: crypto.getRandomValues(new Uint8Array(64)),
    });

  test("LA1: the identity's list elsewhere, none here: a list in waiting, at the server", async () => {
    const server = new FakeKeyringServer();
    const gateway = new FakeGateway();
    elsewhere(gateway, "u-1");
    const { env, local } = device(server, gateway);
    await signInKept(local, gateway, "u-1");
    const gate = new Gate();
    gate.set(signedIn("u-1"));

    const page = await tab(env, gateway, gate, server);
    await page.association.settled();

    expect(page.association.situation()).toMatchObject({ kind: "open-here" });
    const session = await page.session();
    expect(session && !isAccountKeyring(session.ref)).toBe(true);
    expect(server.keyrings.size).toBe(1);
    expect((await local.load())?.ref).toMatchObject({
      keyringId: (session?.ref as { keyringId: string }).keyringId,
    });
    expect(gateway.keyringOf("u-1").version).toBe(1);
  });

  test("LA1, case 1: two tabs at once: one list in waiting, the other's keyring deleted", async () => {
    const server = new FakeKeyringServer();
    const gateway = new FakeGateway();
    elsewhere(gateway, "u-1");
    const { env, local } = device(server, gateway);
    await signInKept(local, gateway, "u-1");
    const gate = new Gate();
    gate.set(signedIn("u-1"));

    const a = await tab(env, gateway, gate, server);
    const b = await tab(env, gateway, gate, server);
    await Promise.all([a.association.settled(), b.association.settled()]);

    const [sa, sb] = [await a.session(), await b.session()];
    const id = (ref: unknown) => (ref as { keyringId?: string }).keyringId;
    expect(id(sa?.ref)).toBeDefined();
    expect(id(sa?.ref)).toBe(id(sb?.ref));
    expect(id(sa?.ref)).toBe(id((await local.load())?.ref));
    await until(async () => server.keyrings.size === 1);
  });

  test("LA1: a list here already: none created", async () => {
    const server = new FakeKeyringServer();
    const gateway = new FakeGateway();
    elsewhere(gateway, "u-1");
    const { env, local } = device(server, gateway);
    const created = await createKeyring(ORIGIN, server.fetch);
    await KeyringSession.adopt(sessionOptions(env, ORIGIN), created);
    await signInKept(local, gateway, "u-1");
    const gate = new Gate();
    gate.set(signedIn("u-1"));

    const page = await tab(env, gateway, gate, server);
    await page.association.settled();

    expect(page.association.situation()).toMatchObject({ kind: "open-here" });
    expect((await page.session())?.ref).toMatchObject({
      keyringId: created.keyringId,
    });
    expect(server.keyrings.size).toBe(1);
  });
});
