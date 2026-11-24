// @vitest-environment jsdom
//
// « Mes documents » kept by an account (analysis 18i.3; docs/protocol/
// 05-keyring.md, KR-39 – KR-44): attaching this device's list to an empty
// account under its own key, or to an account that has one with its key;
// a new device; the token expired (TR6) or of another account (TR7);
// adding a device through the gateway. On fake-indexeddb, a keyring
// server and a gateway in memory.
import { IDBFactory } from "fake-indexeddb";
import { flushSync } from "svelte";
import { beforeEach, describe, expect, onTestFinished, test } from "vitest";
import {
  createKeyring,
  decryptKeyring,
  formatAccountKey,
  listKeyring,
  readKeyringPlaintext,
  rememberLink,
} from "../../lib/src/index.js";
import { FakeKeyringServer } from "../../lib/src/keyring/test-support/fake-keyring-server.js";
import { testLink } from "../../lib/src/keyring/test-support/links.js";
import { ActivityCount } from "../../lib/src/transport/test-support/activity-count.js";
import { t } from "../i18n/index.js";
import type { KeyringEnvironment } from "../keyring/environment.js";
import { sessionOptions } from "../keyring/environment.js";
import { type HomeView, mountHome } from "../keyring/home.js";
import { type KeyringLock, openKeyringLocal } from "../keyring/local.js";
import { isAccountKeyring, linkOf } from "../keyring/ref.js";
import { KeyringSession } from "../keyring/session.js";
import { ACCOUNT_CHANNEL } from "./channels.js";
import { ChannelBus, FakeGateway } from "./test-support.js";

const ORIGIN = "https://collab.test";

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

interface Device {
  env: KeyringEnvironment;
  local: ReturnType<typeof openKeyringLocal>;
  bus: ChannelBus;
  view?: HomeView;
}

/** What the devices of a test have in progress (AGENTS.md §1.6): their
 * requests, their stores, their timers, WebCrypto. */
let activity = new ActivityCount();
beforeEach(() => {
  activity = new ActivityCount();
  onTestFinished(activity.countCrypto());
});

/** Once nothing is in progress, `holds` holds. */
async function quietThen(holds: () => boolean): Promise<void> {
  await activity.settled();
  expect(holds()).toBe(true);
}

/** A device of the deployment: its storage, its pages' channels. */
function device(server: FakeKeyringServer, gateway: FakeGateway): Device {
  const local = activity.methods(
    openKeyringLocal({
      indexedDB: new IDBFactory(),
      lock: memoryLock(),
    }),
  );
  const bus = new ChannelBus();
  return {
    local,
    bus,
    env: {
      local,
      fetch: activity.counted(async (url: string, init?: RequestInit) => {
        const { origin, pathname } = new URL(url);
        if (origin === gateway.origin) return gateway.fetch(url, init);
        if (pathname === "/config.json") {
          return new Response(JSON.stringify({ gateway: gateway.origin }));
        }
        return server.fetch(url, init);
      }),
      // The synchronisation's delays shortened; a token's deadline, an
      // hour away, never comes in a test.
      setTimer: (run, ms) => {
        if (ms >= 60_000) return () => {};
        return activity.timers((go, after) => {
          const timer = setTimeout(go, Math.min(after, 20));
          return () => clearTimeout(timer);
        })(run, ms);
      },
      account: {
        local,
        openWindow: () => {},
        channel: (name) => bus.channel(name),
      },
    },
  };
}

/** `sub` signed in on `dev`, as another tab would have done it. */
async function signIn(dev: Device, gateway: FakeGateway, sub: string) {
  await dev.local.keepSignedIn({
    gateway: gateway.origin,
    token: gateway.tokenOf(sub),
    deadline: Date.now() + 3_600_000,
    name: sub,
    email: null,
    issuer: "https://idp.example",
    sub,
  });
  dev.bus.postFromElsewhere(ACCOUNT_CHANNEL, { changed: true });
  dev.bus.deliverAll();
}

async function open(
  dev: Device,
  server: FakeKeyringServer,
  pairing?: Parameters<typeof mountHome>[1]["pairing"],
): Promise<HomeView> {
  dev.view?.close();
  document.body.innerHTML = "";
  const view = mountHome(document.body, {
    apiBase: ORIGIN,
    keyring: dev.env,
    createKeyring: () => createKeyring(ORIGIN, server.fetch),
    confirm: () => true,
    copy: async () => {},
    now: () => Date.now(),
    ...(pairing && { pairing }),
  });
  dev.view = view;
  await view.ready;
  await view.accountReady;
  return view;
}

/** Once nothing is in progress, `condition` holds, read once. */
async function until(condition: () => Promise<boolean>): Promise<void> {
  await activity.settled();
  expect(await condition()).toBe(true);
}

const $ = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector);
const text = () => document.body.textContent ?? "";
const click = (selector: string) => {
  const target = $(selector);
  if (!target) throw new Error(`no ${selector}`);
  target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  flushSync();
};
const type = (selector: string, value: string) => {
  const input = $<HTMLInputElement>(selector);
  if (!input) throw new Error(`no ${selector}`);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
};

/** The documents of `sub`'s keyring on the gateway, under `key`. */
async function onGateway(
  gateway: FakeGateway,
  sub: string,
  key: Uint8Array,
): Promise<string[]> {
  const { blob } = gateway.keyringOf(sub);
  if (blob.length === 0) return [];
  const doc = readKeyringPlaintext(await decryptKeyring(key, blob));
  if (!doc) throw new Error("the account's keyring doesn't read");
  return listKeyring(doc)
    .map((entry) => entry.documentId)
    .sort();
}

/** A list kept by a keyring link on `dev`, holding `documents`. */
async function keepByLink(
  dev: Device,
  server: FakeKeyringServer,
  documents: string[],
) {
  await open(dev, server);
  click(".home-keep");
  await quietThen(() => dev.view?.session() !== undefined);
  const session = dev.view?.session();
  for (const doc of documents) {
    await session?.change(
      (d) => void rememberLink(d, testLink(doc, "edit"), { at: 1 }),
    );
  }
  await quietThen(
    () =>
      server.keyrings.get(linkOf(session?.ref ?? ({} as never)).keyringId)
        ?.version !== 0,
  );
  return session;
}

describe("Mes documents kept by an account", () => {
  test("attached to an empty account under this device's key; the link's keyring then deleted (KR-44)", async () => {
    const server = new FakeKeyringServer();
    const gateway = new FakeGateway();
    const a = device(server, gateway);
    const before = await keepByLink(a, server, ["d1"]);
    const link = linkOf(before?.ref ?? ({} as never));
    await signIn(a, gateway, "u-1");
    // A list that holds documents: asked, the identity and the titles
    // named (18o.2).
    await quietThen(() => $(".home-attach") !== null);
    expect($(".home-associate")?.textContent).toContain(t().untitled);
    expect($(".home-associate")?.textContent).toContain(
      t().associateQuestion(1, t().yourIdentity(undefined, "u-1")),
    );
    click(".home-attach");
    await quietThen(() => gateway.keyringOf("u-1").version > 0);
    const session = a.view?.session();
    expect(session && isAccountKeyring(session.ref)).toBe(true);
    // Its own K_t: its other devices, which have it, only sign in.
    expect(session?.ref.key).toEqual(link.key);
    expect(await onGateway(gateway, "u-1", link.key)).toEqual(["d1"]);
    await quietThen(() => !server.keyrings.has(link.keyringId));
    expect($(".home-attach")).toBeNull();
    // Reopened, the list is the account's.
    await open(a, server);
    expect(a.view?.session()?.ref).toMatchObject({ sub: "u-1" });
  });

  test("an account that has a list needs its key; this device's copy merges into it", async () => {
    const server = new FakeKeyringServer();
    const gateway = new FakeGateway();
    // Device A: the account's list, holding d1.
    const a = device(server, gateway);
    await signIn(a, gateway, "u-1");
    await open(a, server);
    // Nothing here to decide: associated without a question (18o.2).
    await quietThen(() => a.view?.session() !== undefined);
    await a.view
      ?.session()
      ?.change((d) => void rememberLink(d, testLink("d1", "edit"), { at: 1 }));
    const accountKey = a.view?.session()?.ref.key as Uint8Array;
    await until(async () =>
      (await onGateway(gateway, "u-1", accountKey)).includes("d1"),
    );
    a.view?.close();
    // Device B: a list by link, holding d2.
    const b = device(server, gateway);
    const own = await keepByLink(b, server, ["d2"]);
    const link = linkOf(own?.ref ?? ({} as never));
    await signIn(b, gateway, "u-1");
    // The account has a list: its key asked at once (18o.2).
    await quietThen(() => text().includes(t().attachNeedsKey));
    // Nothing written yet, nothing deleted.
    expect(server.keyrings.has(link.keyringId)).toBe(true);
    type(".home-account-key", "oc-keyring:v1:wrong");
    click(".home-use-account-key");
    await quietThen(() => text().includes(t().keyInvalid));
    type(".home-account-key", formatAccountKey(accountKey));
    click(".home-use-account-key");
    await until(
      async () => (await onGateway(gateway, "u-1", accountKey)).length === 2,
    );
    expect(await onGateway(gateway, "u-1", accountKey)).toEqual(["d1", "d2"]);
    await quietThen(() => !server.keyrings.has(link.keyringId));
  });

  test("case 3: a keyring deleted once attached elsewhere; this device attaches in its turn", async () => {
    const server = new FakeKeyringServer();
    const gateway = new FakeGateway();
    // Device A attaches the shared list's content to the account.
    const a = device(server, gateway);
    await signIn(a, gateway, "u-1");
    await open(a, server);
    // Nothing here to decide: associated without a question (18o.2).
    await quietThen(() => a.view?.session() !== undefined);
    await a.view
      ?.session()
      ?.change((d) => void rememberLink(d, testLink("d1", "edit"), { at: 1 }));
    const accountKey = a.view?.session()?.ref.key as Uint8Array;
    await until(async () =>
      (await onGateway(gateway, "u-1", accountKey)).includes("d1"),
    );
    a.view?.close();
    // Device B wrote its list by link, which is then deleted (as A's
    // attaching would): 404, its copy kept (cas 12).
    const b = device(server, gateway);
    const own = await keepByLink(b, server, ["d2"]);
    server.delete(linkOf(own?.ref ?? ({} as never)).keyringId);
    await b.view?.session()?.sync();
    await quietThen(() => text().includes(t().keyringGone));
    await signIn(b, gateway, "u-1");
    await quietThen(() => $(".home-account-key") !== null);
    type(".home-account-key", formatAccountKey(accountKey));
    click(".home-use-account-key");
    await until(
      async () => (await onGateway(gateway, "u-1", accountKey)).length === 2,
    );
    expect(await onGateway(gateway, "u-1", accountKey)).toEqual(["d1", "d2"]);
  });

  test("a new device signed in: the account's key opens its list", async () => {
    const server = new FakeKeyringServer();
    const gateway = new FakeGateway();
    const a = device(server, gateway);
    await signIn(a, gateway, "u-1");
    await open(a, server);
    // Nothing here to decide: associated without a question (18o.2).
    await quietThen(() => a.view?.session() !== undefined);
    await a.view
      ?.session()
      ?.change((d) => void rememberLink(d, testLink("d1", "edit"), { at: 1 }));
    const accountKey = a.view?.session()?.ref.key as Uint8Array;
    await until(async () =>
      (await onGateway(gateway, "u-1", accountKey)).includes("d1"),
    );
    a.view?.close();

    const b = device(server, gateway);
    await signIn(b, gateway, "u-1");
    await open(b, server);
    await quietThen(() => $(".home-account-key") !== null);
    type(".home-account-key", formatAccountKey(accountKey));
    click(".home-use-account-key");
    await quietThen(() => $(".home-entry") !== null);
    expect($(".home-entry")?.dataset.document).toBe("d1");
  });

  test("TR6: signed out, the list is kept and written here; signed in again, it syncs", async () => {
    const server = new FakeKeyringServer();
    const gateway = new FakeGateway();
    const a = device(server, gateway);
    await signIn(a, gateway, "u-1");
    await open(a, server);
    // Nothing here to decide: associated without a question (18o.2) —
    // and said: written at the gateway is not yet the association ended.
    await quietThen(() =>
      text().includes(t().associatedFuture(t().yourIdentity(undefined, "u-1"))),
    );
    const key = a.view?.session()?.ref.key as Uint8Array;
    // The token ends: forgotten here, as « Se déconnecter » does.
    const kept = await a.local.signedIn();
    gateway.tokens.delete(kept?.token ?? "");
    await a.view
      ?.session()
      ?.change((d) => void rememberLink(d, testLink("d3", "edit"), { at: 1 }));
    await quietThen(() => text().includes(t().keyringSignedOut));
    expect(await onGateway(gateway, "u-1", key)).toEqual([]);
    // Reloaded meanwhile: still there.
    await open(a, server);
    // Its first sync found no token: the next one is the sign-in's.
    await quietThen(() => text().includes(t().keyringSignedOut));
    expect(
      a.view
        ?.session()
        ?.entries()
        .map((e) => e.documentId),
    ).toEqual(["d3"]);
    await signIn(a, gateway, "u-1");
    await until(
      async () => (await onGateway(gateway, "u-1", key)).length === 1,
    );
  });

  test("TR6: the token ends while associating: what the sync says stays, not the association", async () => {
    const server = new FakeKeyringServer();
    const gateway = new FakeGateway();
    const a = device(server, gateway);
    // The association's write is the first one at the gateway: its token
    // ends just before.
    const fetch = a.env.fetch;
    a.env.fetch = (url, init) => {
      if (url.endsWith("/accounts/keyring") && init?.method === "PUT") {
        gateway.tokens.clear();
      }
      return fetch(url, init);
    };
    await signIn(a, gateway, "u-1");
    await open(a, server);
    // The association ended: its name kept, after what it says.
    await until(
      async () =>
        (await a.local.identityName({
          gateway: gateway.origin,
          issuer: "https://idp.example",
          sub: "u-1",
        })) === "u-1",
    );
    expect(gateway.keyringOf("u-1").version).toBe(0);
    expect(text()).toContain(t().keyringSignedOut);
    expect(text()).not.toContain(
      t().associatedFuture(t().yourIdentity(undefined, "u-1")),
    );
  });

  test("TR7: another account signed in: the list is never read nor written with its token", async () => {
    const server = new FakeKeyringServer();
    const gateway = new FakeGateway();
    const a = device(server, gateway);
    await signIn(a, gateway, "u-1");
    await open(a, server);
    // Nothing here to decide: associated without a question (18o.2).
    await quietThen(() => gateway.keyringOf("u-1").version > 0);
    // Its name kept on this device, after the association: said below.
    await until(
      async () =>
        (await a.local.identityName({
          gateway: gateway.origin,
          issuer: "https://idp.example",
          sub: "u-1",
        })) === "u-1",
    );
    await signIn(a, gateway, "u-2");
    await a.view
      ?.session()
      ?.change((d) => void rememberLink(d, testLink("d1", "edit"), { at: 1 }));
    // Said, with the other identity and the documents; nothing done
    // until a choice (18o.2).
    await quietThen(() => $(".home-other") !== null);
    expect($(".home-other")?.textContent).toContain(
      t().otherIdentityQuestion(1, "u-1", t().yourIdentity(undefined, "u-2")),
    );
    await a.view?.session()?.sync();
    expect(gateway.asked.filter((r) => r.sub === "u-2")).toEqual([]);
    expect($(".home-attach")).toBeNull();
  });

  // Analysis 18o.2, found at the real trial: the identity changed (the
  // provider gave another subject), or another person signed in.
  test("another identity's list: associated with the identity signed in, under a key of its own", async () => {
    const server = new FakeKeyringServer();
    const gateway = new FakeGateway();
    const a = device(server, gateway);
    await signIn(a, gateway, "u-1");
    await open(a, server);
    await quietThen(() => gateway.keyringOf("u-1").version > 0);
    await a.view
      ?.session()
      ?.change((d) => void rememberLink(d, testLink("d1", "edit"), { at: 1 }));
    const otherKey = a.view?.session()?.ref.key as Uint8Array;
    await signIn(a, gateway, "u-2");
    await quietThen(() => $(".home-associate-other") !== null);

    click(".home-associate-other");

    await quietThen(() => gateway.keyringOf("u-2").version > 0);
    const session = a.view?.session();
    expect(session?.ref).toMatchObject({ sub: "u-2" });
    expect(session?.ref.key).not.toEqual(otherKey);
    await until(
      async () =>
        (await onGateway(gateway, "u-2", session?.ref.key as Uint8Array))
          .length === 1,
    );
    expect($(".home-other")).toBeNull();
  });

  test("another identity's list, not kept here: this browser's list is the identity's", async () => {
    const server = new FakeKeyringServer();
    const gateway = new FakeGateway();
    const a = device(server, gateway);
    await signIn(a, gateway, "u-1");
    await open(a, server);
    await quietThen(() => gateway.keyringOf("u-1").version > 0);
    await a.view
      ?.session()
      ?.change((d) => void rememberLink(d, testLink("d1", "edit"), { at: 1 }));
    await signIn(a, gateway, "u-2");
    await quietThen(() => $(".home-forget-other") !== null);

    click(".home-forget-other");

    // Nothing here any more: associated without a question, empty.
    await quietThen(() => gateway.keyringOf("u-2").version > 0);
    expect(a.view?.session()?.ref).toMatchObject({ sub: "u-2" });
    expect(a.view?.session()?.entries()).toEqual([]);
    // The other identity's list untouched at the gateway.
    expect(gateway.keyringOf("u-1").version).toBeGreaterThan(0);
  });

  test("adding a device through the gateway: given to the same account only (KR-41, KR-43)", async () => {
    const server = new FakeKeyringServer();
    const gateway = new FakeGateway();
    const a = device(server, gateway);
    await signIn(a, gateway, "u-1");
    await open(a, server);
    // Nothing here to decide: associated without a question (18o.2).
    await quietThen(() => a.view?.session() !== undefined);
    await a.view
      ?.session()
      ?.change((d) => void rememberLink(d, testLink("d1", "edit"), { at: 1 }));
    click(".home-add-device");
    await quietThen(
      () => $<HTMLInputElement>(".home-pairing-link")?.value !== undefined,
    );
    const address = new URL(
      $<HTMLInputElement>(".home-pairing-link")?.value ?? "",
    );
    expect(address.searchParams.has("account")).toBe(true);
    const accountKey = a.view?.session()?.ref.key as Uint8Array;
    await until(async () =>
      (await onGateway(gateway, "u-1", accountKey)).includes("d1"),
    );
    a.view?.close();

    const { readPairingAddress } = await import("../../lib/src/index.js");
    const pairing = readPairingAddress(address.search, address.hash);
    // Device B, not signed in yet: the code waits for its sign-in.
    const b = device(server, gateway);
    await open(b, server, pairing);
    await quietThen(() => text().includes(t().pairingSignInFirst));
    await signIn(b, gateway, "u-1");
    await quietThen(() => $(".home-entry") !== null);
    expect($(".home-entry")?.dataset.document).toBe("d1");
    expect(b.view?.session()?.ref).toMatchObject({ sub: "u-1" });
  });

  test("TR7: a list attached to one account never joins another's, even if asked", async () => {
    // Security review of 18i.3: u-2 signed in on a device whose list is
    // u-1's, opening u-2's pairing address.
    const server = new FakeKeyringServer();
    const gateway = new FakeGateway();
    const other = device(server, gateway);
    await signIn(other, gateway, "u-2");
    await open(other, server);
    // Nothing here to decide: associated without a question (18o.2).
    await quietThen(() => other.view?.session() !== undefined);
    click(".home-add-device");
    await quietThen(() => $<HTMLInputElement>(".home-pairing-link") !== null);
    const address = new URL(
      $<HTMLInputElement>(".home-pairing-link")?.value ?? "",
    );
    other.view?.close();

    const a = device(server, gateway);
    await signIn(a, gateway, "u-1");
    await open(a, server);
    // Nothing here to decide: associated without a question (18o.2).
    await quietThen(() => a.view?.session() !== undefined);
    await a.view
      ?.session()
      ?.change((d) => void rememberLink(d, testLink("d1", "edit"), { at: 1 }));
    const mine = a.view?.session()?.ref.key as Uint8Array;
    await until(async () =>
      (await onGateway(gateway, "u-1", mine)).includes("d1"),
    );
    await signIn(a, gateway, "u-2");
    const { readPairingAddress } = await import("../../lib/src/index.js");
    // The page would ask: the person says yes (`confirm` is true here).
    await open(a, server, readPairingAddress(address.search, address.hash));
    await quietThen(() => text().includes(t().pairingKeptOwn));
    expect(a.view?.session()?.ref).toMatchObject({ sub: "u-1" });
    const theirs = other.view?.session()?.ref.key as Uint8Array;
    expect(await onGateway(gateway, "u-2", theirs)).toEqual([]);
  });

  // Analysis 18o.2: a first device, nothing here: associated at once,
  // said in the future tense.
  test("a first device with no list: associated without a question", async () => {
    const server = new FakeKeyringServer();
    const gateway = new FakeGateway();
    const a = device(server, gateway);
    await open(a, server);
    await signIn(a, gateway, "u-1");
    // Said once the list is written and synced.
    await quietThen(() =>
      text().includes(t().associatedFuture(t().yourIdentity(undefined, "u-1"))),
    );
    expect(gateway.keyringOf("u-1").version).toBeGreaterThan(0);
    expect(a.view?.session()?.ref).toMatchObject({ sub: "u-1" });
    expect($(".home-attach")).toBeNull();
  });

  test("« Plus tard »: the list stays apart, and is offered again without the question", async () => {
    const server = new FakeKeyringServer();
    const gateway = new FakeGateway();
    const a = device(server, gateway);
    const own = await keepByLink(a, server, ["d1", "d2"]);
    await signIn(a, gateway, "u-1");
    await quietThen(() => $(".home-later") !== null);
    click(".home-later");
    await quietThen(() => $(".home-later") === null);
    expect(a.view?.session()?.ref).toEqual(own?.ref);
    expect(gateway.keyringOf("u-1").version).toBe(0);
    expect(
      await a.local.associationLater({
        gateway: gateway.origin,
        issuer: "https://idp.example",
        sub: "u-1",
      }),
    ).toBe(true);
    // Reopened: offered again, quietly.
    await open(a, server);
    await quietThen(() => $(".home-attach") !== null);
    expect($(".home-later")).toBeNull();
    click(".home-attach");
    await quietThen(() => gateway.keyringOf("u-1").version > 0);
  });

  test("more than five documents: five titles, and how many others", async () => {
    const server = new FakeKeyringServer();
    const gateway = new FakeGateway();
    const a = device(server, gateway);
    await keepByLink(a, server, ["d1", "d2", "d3", "d4", "d5", "d6", "d7"]);
    await signIn(a, gateway, "u-1");
    await quietThen(() => $(".home-attach") !== null);
    const shown = $(".home-associate")?.textContent ?? "";
    expect(shown).toContain(t().associateMore(2));
    expect(document.querySelectorAll(".home-associate li").length).toBe(5);
  });

  test("18p.2: the identity's list elsewhere, a list in waiting here: shown, said where the list is, joined by the account's key", async () => {
    const server = new FakeKeyringServer();
    const gateway = new FakeGateway();
    const a = device(server, gateway);
    await signIn(a, gateway, "u-1");
    await open(a, server);
    await quietThen(() => a.view?.session() !== undefined);
    await a.view
      ?.session()
      ?.change((d) => void rememberLink(d, testLink("d1", "edit"), { at: 1 }));
    const accountKey = a.view?.session()?.ref.key as Uint8Array;
    await until(async () =>
      (await onGateway(gateway, "u-1", accountKey)).includes("d1"),
    );
    a.view?.close();
    // Device B, signed in: a document opened made a list in waiting
    // (LA1), by link, its key never shown.
    const b = device(server, gateway);
    await signIn(b, gateway, "u-1");
    const created = await createKeyring(ORIGIN, server.fetch);
    const waiting = await KeyringSession.adopt(
      sessionOptions(b.env, ORIGIN),
      created,
    );
    await waiting?.change(
      (d) => void rememberLink(d, testLink("d2", "edit"), { at: 2 }),
    );
    waiting?.close();
    await open(b, server);
    await quietThen(() => $(".home-account-key") !== null);
    expect(text()).toContain(t().attachNeedsKey);
    expect($(".home-entry")?.dataset.document).toBe("d2");
    // Kept on the server for the identity, not by a key (18p.3); starting
    // over offered, the warning about a key not said for a key unshown.
    expect($("details.home-modes .current")?.dataset.mode).toBe("identity");
    expect($(".home-start-over")).not.toBeNull();
    expect($(".home-warning")).toBeNull();
    // A list of its own isn't offered, nor its key, while signed in.
    for (const selector of [
      ".home-keep",
      ".home-show-key",
      ".home-change-key",
      ".home-add-device",
    ]) {
      expect($(selector), selector).toBeNull();
    }
    type(".home-account-key", formatAccountKey(accountKey));
    click(".home-use-account-key");
    await until(
      async () => (await onGateway(gateway, "u-1", accountKey)).length === 2,
    );
    await quietThen(() => !server.keyrings.has(created.keyringId));
    await quietThen(() => $(".home-show-key") !== null);
  });

  test("18p.2: where the documents are kept, said; how they can be, explained", async () => {
    const server = new FakeKeyringServer();
    const gateway = new FakeGateway();
    // Nothing kept: said, and the ways explained, open.
    const a = device(server, gateway);
    await open(a, server);
    await quietThen(() => $(".home-sign-in") !== null);
    expect($(".home-mode")?.textContent).toBe(t().homeKeptNowhere);
    const modes = $<HTMLDetailsElement>("details.home-modes");
    expect(modes?.open).toBe(true);
    expect(modes?.querySelector(".current")?.getAttribute("data-mode")).toBe(
      "none",
    );
    expect(modes?.textContent).toContain(t().homeModeIdentity);
    expect(modes?.textContent).toContain(t().homeModesPrivate);
    expect($(".home-warning")).toBeNull();
    // Kept by a key.
    await keepByLink(a, server, ["d1"]);
    await quietThen(() => $(".home-mode")?.textContent === t().homeKeptByKey);
    expect($("details.home-modes .current")?.dataset.mode).toBe("key");
    expect($<HTMLDetailsElement>("details.home-modes")?.open).toBe(false);
    // A list lost is lost: said, apart (18p.3).
    expect($(".home-warning")?.textContent).toContain(t().homeKeyWarning);
    // Kept with the identity, signed in.
    const b = device(server, gateway);
    await signIn(b, gateway, "u-1");
    await open(b, server);
    await quietThen(() =>
      isAccountKeyring(b.view?.session()?.ref ?? ({} as never)),
    );
    await quietThen(
      () =>
        $(".home-mode")?.textContent ===
        t().homeKeptByIdentity(t().yourIdentity(undefined, "u-1")),
    );
    expect($("details.home-modes .current")?.dataset.mode).toBe("identity");
    expect($(".home-keep")).toBeNull();
    // Signing in doesn't open a list lost either (18p.3).
    expect($(".home-warning")?.textContent).toContain(t().homeKeyWarning);
    expect($(".home-start-over")).toBeNull();
  });
});
