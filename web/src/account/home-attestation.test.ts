// @vitest-environment jsdom
//
// The home with a gateway that attests (analysis 18k, « Obtenir
// l'attestation »): signed in recently, a list attached to the account,
// its keyring's key registered and attested, the attestation kept on the
// device; signed in without recency, nothing registered, and the next
// sign-in asked recent. On fake-indexeddb, a keyring server and a gateway
// in memory, of keyrings and of keys.
import { IDBFactory } from "fake-indexeddb";
import { flushSync } from "svelte";
import { describe, expect, onTestFinished, test } from "vitest";
import {
  createKeyring,
  decryptKeyring,
  encryptKeyring,
  formatAccountKey,
  keyringIdentity,
  listKeyring,
  newKeyringDoc,
  newKeyringSecrets,
  ownKeys,
  readKeyringPlaintext,
  rememberLink,
} from "../../lib/src/index.js";
import { FakeKeyringServer } from "../../lib/src/keyring/test-support/fake-keyring-server.js";
import { testLink } from "../../lib/src/keyring/test-support/links.js";
import { ActivityCount } from "../../lib/src/transport/test-support/activity-count.js";
import { t } from "../i18n/index.js";
import { sessionOptions } from "../keyring/environment.js";
import { type HomeView, mountHome } from "../keyring/home.js";
import { type KeyringLock, openKeyringLocal } from "../keyring/local.js";
import { KeyringSession } from "../keyring/session.js";
import { ACCOUNT_CHANNEL, SIGN_IN_CHANNEL } from "./channels.js";
import {
  ChannelBus,
  FakeGateway,
  codeOf,
  requestOf,
  sessionAnswer,
} from "./test-support.js";
import { KeysGateway } from "./test-support/keys-gateway.js";

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

async function setUp() {
  const server = new FakeKeyringServer();
  const keyrings = new FakeGateway();
  const keys = await KeysGateway.create();
  keys.now = Date.now();
  // What the home has in progress (AGENTS.md §1.6): its requests, the
  // device's stores, its timers, WebCrypto — waited for, never a delay.
  const activity = new ActivityCount();
  onTestFinished(activity.countCrypto());
  const local = activity.methods(
    openKeyringLocal({
      indexedDB: new IDBFactory(),
      lock: memoryLock(),
    }),
  );
  const bus = new ChannelBus();
  const opened: string[] = [];
  /** What the page's `confirm` answers. */
  const answers = { confirm: true };
  const env = {
    local,
    fetch: activity.counted(async (url: string, init?: RequestInit) => {
      const { origin, pathname } = new URL(url);
      if (origin === keyrings.origin) {
        // The window's return exchanged: a recent token (ID-28).
        if (pathname === "/accounts/session") {
          const token = keyrings.tokenOf("u-1");
          keys.token(token, "u-1", true);
          return sessionAnswer(token);
        }
        return /^\/accounts\/(me|key|attestation)$/.test(pathname)
          ? keys.fetch(url, init)
          : keyrings.fetch(url, init);
      }
      if (pathname === "/revocations") {
        return new Response(await keys.revocationsBody(), { status: 200 });
      }
      if (pathname === "/config.json") {
        return Response.json({
          gateway: keyrings.origin,
          attestationKeys: [keys.fingerprint],
        });
      }
      return server.fetch(url, init);
    }),
    setTimer: (run: () => void, ms: number) => {
      if (ms >= 60_000) return () => {};
      return activity.timers((go, after) => {
        const timer = setTimeout(go, Math.min(after, 20));
        return () => clearTimeout(timer);
      })(run, ms);
    },
    account: {
      local,
      openWindow: (url: string) => opened.push(url),
      channel: (name: string) => bus.channel(name),
    },
  };
  /** `sub` signed in, as another tab would have done it. */
  const signIn = async (sub: string, recent: boolean) => {
    const token = keyrings.tokenOf(sub);
    keys.token(token, sub, recent);
    await local.keepSignedIn({
      gateway: keyrings.origin,
      token,
      deadline: Date.now() + 3_600_000,
      ...(recent && { recentUntil: Date.now() + 600_000 }),
      name: sub,
      email: null,
      issuer: "https://idp.example",
      sub,
    });
    bus.postFromElsewhere(ACCOUNT_CHANNEL, { changed: true });
    bus.deliverAll();
  };
  let view: HomeView | undefined;
  const open = async () => {
    view?.close();
    document.body.innerHTML = "";
    view = mountHome(document.body, {
      apiBase: ORIGIN,
      keyring: env,
      createKeyring: () => createKeyring(ORIGIN, server.fetch),
      confirm: () => answers.confirm,
      copy: async () => {},
      now: () => Date.now(),
    });
    await view.ready;
    await view.accountReady;
    return view;
  };
  /** The window comes back for the attempt it was opened with. */
  const windowReturns = () => {
    bus.postFromElsewhere(SIGN_IN_CHANNEL, {
      request: requestOf(opened.at(-1) as string),
      code: codeOf(7),
    });
    bus.deliverAll();
  };
  /** A list of one document on this device, not an identity's. */
  const listHere = async () => {
    const created = await createKeyring(ORIGIN, server.fetch);
    const own = await KeyringSession.adopt(
      sessionOptions(env, ORIGIN),
      created,
    );
    await own?.change(
      (d) => void rememberLink(d, testLink("d1", "edit"), { at: 1 }),
    );
    own?.close();
  };
  /** The identity's list at the gateway, under a key no device here has,
   * and a key registered for it (analysis 18p.3). */
  const listLost = async () => {
    const lost = newKeyringDoc();
    rememberLink(lost, testLink("lost", "edit"), { at: 1 });
    keyrings.keyrings.set("u-1", {
      version: 3,
      blob: await encryptKeyring(
        newKeyringSecrets().key,
        lost.export({ mode: "snapshot" }),
      ),
    });
    const oldKey = new Uint8Array(32).fill(0x11);
    keys.accounts.set("u-1", {
      issuer: "https://idp.example",
      sub: "u-1",
      key: oldKey,
    });
    return oldKey;
  };
  /** The documents of the identity's list at the gateway, under `key`. */
  const onGateway = async (key: Uint8Array) => {
    const doc = readKeyringPlaintext(
      await decryptKeyring(key, keyrings.keyringOf("u-1").blob),
    );
    return doc ? listKeyring(doc).map((e) => e.documentId) : undefined;
  };
  /** Once nothing is in progress, `holds` holds. */
  const until = async (holds: () => boolean) => {
    await activity.settled();
    expect(holds()).toBe(true);
  };
  return {
    settled: () => activity.settled(),
    until,
    keys,
    keyrings,
    local,
    opened,
    answers,
    signIn,
    open,
    windowReturns,
    listHere,
    listLost,
    onGateway,
  };
}

const click = (selector: string) => {
  const target = document.querySelector(selector);
  if (!target) throw new Error(`no ${selector}`);
  target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  flushSync();
};

describe("the home with a gateway that attests", () => {
  test("recently signed in, the list associated at once: its key registered and attested", async () => {
    const s = await setUp();
    await s.signIn("u-1", true);
    const view = await s.open();
    // Nothing here to decide: associated without a question (18o.2).
    await s.until(() => view.session() !== undefined);
    await s.until(() => s.keys.accounts.get("u-1")?.key !== undefined);
    await s.settled();
    const kept = await s.local.attestation();
    expect(kept?.sub).toBe("u-1");
    view.close();
  });

  test("signed in without recency: nothing registered; the next sign-in asked recent", async () => {
    const s = await setUp();
    await s.signIn("u-1", false);
    const view = await s.open();
    // Nothing here to decide: associated without a question (18o.2).
    await s.until(() => view.session() !== undefined);
    // Asked, and refused for want of recency: no key held.
    await s.until(() => s.keys.asked.includes("/accounts/attestation"));
    expect(s.keys.asked).not.toContain("/accounts/key");
    expect(s.keys.accounts.get("u-1")?.key).toBeUndefined();
    click(".home-sign-out");
    await s.until(() => document.querySelector(".home-sign-in") !== null);
    await s.until(
      () =>
        !(document.querySelector(".home-sign-in") as HTMLButtonElement)
          .disabled,
    );
    click(".home-sign-in");
    expect(s.opened.at(-1)).toMatch(/&fresh$/);
    view.close();
  });

  // Analysis 18o.3, IC3: the last step said at the home page.
  test("IC3: associated, the key not registered: « Dernière étape », a recent sign-in", async () => {
    const s = await setUp();
    await s.signIn("u-1", false);
    const view = await s.open();
    await s.until(() => document.querySelector(".home-confirm") !== null);
    expect(document.body.textContent).toContain(t().homeLastStep);
    click(".home-confirm-identity");
    expect(s.opened.at(-1)).toMatch(/&fresh$/);
    // The window returns: registered, attested, the step gone.
    s.windowReturns();
    await s.until(() => s.keys.accounts.get("u-1")?.key !== undefined);
    await s.until(() => document.querySelector(".home-confirm") === null);
    view.close();
  });

  // Analysis 18o.3, IC2: « Associer » with a sign-in not recent — the
  // recent sign-in opened in the same click, the association going on.
  test("IC2: « Associer », not recent: one gesture — associated, then registered once back", async () => {
    const s = await setUp();
    await s.listHere();
    await s.signIn("u-1", false);
    const view = await s.open();
    await s.until(() => document.querySelector(".home-attach") !== null);
    click(".home-attach");
    expect(s.opened.at(-1)).toMatch(/&fresh$/);
    // Associated while the window is open.
    await s.until(
      () =>
        (view.session()?.ref as { sub?: string } | undefined)?.sub === "u-1",
    );
    s.windowReturns();
    await s.until(() => s.keys.accounts.get("u-1")?.key !== undefined);
    expect(document.querySelector(".home-confirm")).toBeNull();
    view.close();
  });

  test("IC2: the recent sign-in cancelled: associated still, the last step said", async () => {
    const s = await setUp();
    await s.listHere();
    await s.signIn("u-1", false);
    const view = await s.open();
    await s.until(() => document.querySelector(".home-attach") !== null);
    click(".home-attach");
    await s.until(
      () =>
        (view.session()?.ref as { sub?: string } | undefined)?.sub === "u-1",
    );
    click(".home-sign-in-cancel");
    await s.until(() => document.querySelector(".home-confirm") !== null);
    expect(s.keys.accounts.get("u-1")?.key).toBeUndefined();
    view.close();
  });

  // Analysis 18p.3: the identity's list elsewhere, its key lost.
  test("RL1: « Recommencer une liste », not recent: after the recent sign-in only, this browser's list replaces the lost one, its key shown, the old identity key revoked", async () => {
    const s = await setUp();
    const oldKey = await s.listLost();
    await s.listHere();
    await s.signIn("u-1", false);
    const view = await s.open();
    await s.until(() => document.querySelector(".home-start-over") !== null);
    expect(document.body.textContent).toContain(t().startOverIntro);
    click(".home-start-over");
    expect(s.opened.at(-1)).toMatch(/&fresh$/);
    // Nothing done before the recent sign-in returns.
    await s.settled();
    expect(s.keyrings.keyringOf("u-1").version).toBe(3);
    s.windowReturns();
    await s.until(() => s.keyrings.keyringOf("u-1").version > 3);
    const ref = view.session()?.ref as { sub?: string; key: Uint8Array };
    expect(ref.sub).toBe("u-1");
    expect(await s.onGateway(ref.key)).toEqual(["d1"]);
    // Its key shown at once, to keep (RL5).
    await s.until(
      () =>
        document.querySelector<HTMLInputElement>(".home-key")?.value ===
        formatAccountKey(ref.key),
    );
    expect(document.body.textContent).toContain(t().startedOver);
    expect(document.querySelector(".home-start-over")).toBeNull();
    // RL4: the list's identity key registered, the old one revoked.
    await s.until(() =>
      s.keys.revoked.has(Buffer.from(oldKey).toString("hex")),
    );
    expect(s.keys.accounts.get("u-1")?.key).not.toEqual(oldKey);
    view.close();
  });

  test("RL1: recently signed in, started over at once; refused at the question, nothing done", async () => {
    const s = await setUp();
    await s.listLost();
    await s.signIn("u-1", true);
    const view = await s.open();
    await s.until(() => document.querySelector(".home-start-over") !== null);
    s.answers.confirm = false;
    click(".home-start-over");
    await s.settled();
    expect(s.keyrings.keyringOf("u-1").version).toBe(3);
    expect(s.opened).toEqual([]);
    s.answers.confirm = true;
    click(".home-start-over");
    // No window: the sign-in is recent already.
    await s.until(() => s.keyrings.keyringOf("u-1").version > 3);
    expect(s.opened).toEqual([]);
    const ref = view.session()?.ref as { key: Uint8Array };
    expect(await s.onGateway(ref.key)).toEqual([]);
    view.close();
  });

  test("RL1: the recent sign-in cancelled: nothing started over", async () => {
    const s = await setUp();
    await s.listLost();
    await s.signIn("u-1", false);
    const view = await s.open();
    await s.until(() => document.querySelector(".home-start-over") !== null);
    click(".home-start-over");
    click(".home-sign-in-cancel");
    await s.settled();
    expect(s.keyrings.keyringOf("u-1").version).toBe(3);
    // Signed in again later, recently, for another reason: still nothing.
    await s.signIn("u-1", true);
    await s.settled();
    expect(s.keyrings.keyringOf("u-1").version).toBe(3);
    expect(document.querySelector(".home-start-over")).not.toBeNull();
    view.close();
  });

  // Phase 30, NK2: the home page reads the revocation list too, and says
  // the key refused though it holds an attestation of it still valid.
  test("NK2: the list's key revoked, an attestation held: refused at the home page, nothing registered", async () => {
    const s = await setUp();
    await s.signIn("u-1", true);
    let view = await s.open();
    await s.until(() => view.session() !== undefined);
    await s.until(() => s.keys.accounts.get("u-1")?.key !== undefined);
    await s.settled();
    expect(await s.local.attestation()).toBeDefined();
    const key = s.keys.accounts.get("u-1")?.key as Uint8Array;
    // Another key registered for the account since (UK6): this one revoked.
    s.keys.revoked.add(Buffer.from(key).toString("hex"));
    s.keys.accounts.set("u-1", {
      issuer: "https://idp.example",
      sub: "u-1",
      key: new Uint8Array(32).fill(0x22),
    });
    s.keys.asked.length = 0;
    view = await s.open();
    await s.until(() => document.querySelector(".home-confirm") !== null);
    expect(document.querySelector(".home-confirm")?.textContent).toContain(
      t().identityRefused,
    );
    expect(s.keys.asked).not.toContain("/accounts/key");
    view.close();
  });

  // Phase 30, NK6: « Nouvelle clé de signature » at the home page — the
  // sign-in recent still: no window; the key replaced, registered, the
  // refusal gone, the old key in `keys`.
  test("NK6: the refused key replaced from the home page: registered, attested, the old one in keys", async () => {
    const s = await setUp();
    await s.signIn("u-1", true);
    let view = await s.open();
    await s.until(() => view.session() !== undefined);
    await s.until(() => s.keys.accounts.get("u-1")?.key !== undefined);
    const old = s.keys.accounts.get("u-1")?.key as Uint8Array;
    s.keys.revoked.add(Buffer.from(old).toString("hex"));
    s.keys.accounts.set("u-1", {
      issuer: "https://idp.example",
      sub: "u-1",
      key: new Uint8Array(32).fill(0x22),
    });
    view = await s.open();
    await s.until(() => document.querySelector(".home-new-key") !== null);
    const opened = s.opened.length;
    click(".home-new-key");
    await s.until(() => document.querySelector(".home-confirm") === null);
    // Recent still: no window opened.
    expect(s.opened.length).toBe(opened);
    const registered = s.keys.accounts.get("u-1")?.key as Uint8Array;
    expect(Buffer.from(registered).toString("hex")).not.toBe(
      Buffer.from(old).toString("hex"),
    );
    const doc = view.session()?.doc;
    expect(doc && keyringIdentity(doc)?.publicKey).toEqual(registered);
    expect(
      doc && ownKeys(doc).map((k) => Buffer.from(k).toString("hex")),
    ).toContain(Buffer.from(old).toString("hex"));
    view.close();
  });
});
