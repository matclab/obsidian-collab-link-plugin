// @vitest-environment jsdom
//
// Two holders of the same account's list in one process (the plugin:
// « Mes documents » and a document view, each its own session and its own
// `identityKeys`), told of the same recent sign-in at once: a list with no
// key yet must end with one key, the gateway's, none revoked (GW1) — else
// a first sign-in revokes the key the list keeps signing with, and the
// identity is to confirm again.
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, test } from "vitest";
import {
  keyringIdentity,
  newKeyringDoc,
  newKeyringSecrets,
} from "../../lib/src/index.js";
import { identityKeys } from "../identity/identity-keys.js";
import { sessionOptions } from "../keyring/environment.js";
import {
  type KeyringLocal,
  type KeyringLock,
  openKeyringLocal,
} from "../keyring/local.js";
import type { AccountKeyring } from "../keyring/ref.js";
import { KEYRING_SYNC_DELAY_MS, KeyringSession } from "../keyring/session.js";
import { Attestor } from "./attestor.js";
import { FakeGateway, memoryAccountLocal } from "./test-support.js";
import { KeysGateway } from "./test-support/keys-gateway.js";

const GATEWAY = "https://accounts.example";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const REF: AccountKeyring = {
  gateway: GATEWAY,
  issuer: "https://idp.example",
  sub: "u-1",
  key: newKeyringSecrets().secret,
};

/** One holder at a time per name, in arrival order (`navigator.locks`);
 * once `hold` is set, none until that many asked — both holders past
 * their own look at the list before either writes. */
function memoryLock(): KeyringLock & { hold(count: number): void } {
  const tails = new Map<string, Promise<unknown>>();
  let waiting = 0;
  let open: Promise<void> = Promise.resolve();
  let arrived = () => {};
  return {
    hold(count) {
      waiting = count;
      open = new Promise((resolve) => {
        arrived = resolve;
      });
    },
    exclusive(name, run) {
      if (waiting > 0 && --waiting === 0) arrived();
      const before = Promise.all([tails.get(name), open]);
      const result = before.then(run, run);
      tails.set(
        name,
        result.catch(() => {}),
      );
      return result;
    },
  };
}

/** A session of the list stored on this device: each holder its own. */
async function accountSession(
  local: KeyringLocal,
  server: { version: number; blob: Uint8Array },
): Promise<KeyringSession> {
  const session = await KeyringSession.open({
    local,
    // The list at the server, empty: read and written in memory.
    transport: () => ({
      read: async () => ({ ...server }),
      write: async (version, blob) => {
        if (version !== server.version) return { stale: server.version };
        server.version = version + 1;
        server.blob = blob;
        return { written: server.version };
      },
    }),
    remove: async () => "missing",
    // The waits after a `412` go at once; the session's own syncs (0 ms
    // at opening, `KEYRING_SYNC_DELAY_MS` after a write) are the test's.
    setTimer: (run, ms) => {
      if (ms > 0 && ms < KEYRING_SYNC_DELAY_MS) queueMicrotask(run);
      return () => {};
    },
  });
  if (!session) throw new Error("no session");
  return session;
}

describe("two holders of the account's list, one sign-in", () => {
  test("one key registered, the list's, none revoked", async () => {
    const gateway = await KeysGateway.create();
    gateway.token("T1", "u-1", true);
    const local = memoryAccountLocal();
    local.stored = {
      gateway: GATEWAY,
      token: "T1",
      deadline: gateway.now + 12 * 3600_000,
      recentUntil: gateway.now + 600_000,
      name: "u-1",
      email: null,
      issuer: REF.issuer,
      sub: REF.sub,
    };
    // The vault's copy of the list, one for every holder (`keyringOf`).
    const lock = memoryLock();
    const device = openKeyringLocal({ indexedDB: new IDBFactory(), lock });
    await device.claim(REF, newKeyringDoc());
    const server = { version: 0, blob: new Uint8Array() };
    const holders = await Promise.all(
      [0, 1].map(async () => {
        const session = await accountSession(device, server);
        // Each read the list at the server (UK4): none has a key there.
        expect(await session.sync()).toBe("synced");
        const keys = identityKeys({ keyring: async () => session });
        const attestor = await Attestor.open({
          gateway: GATEWAY,
          configured: new Set([gateway.fingerprint]),
          local,
          fetch: (url, init) => gateway.fetch(url, init),
          now: () => gateway.now,
          setTimer: () => () => {},
          accountSigner: (account) => keys.accountSigner(account),
        });
        return { session, attestor };
      }),
    );
    // Told of the sign-in at once (`ACCOUNT_CHANNEL`): each draws, then
    // writes — the two writes held until both asked.
    lock.hold(2);
    await Promise.all(holders.map(({ attestor }) => attestor.refresh()));
    // UK1: one key written in the list's history, on this device.
    const stored = await device.load();
    const writes = stored?.doc
      ?.exportJsonUpdates()
      .changes.flatMap((change) => change.ops)
      .filter((op) => op.container === "cid:root-identity:Map");
    expect(writes?.length).toBe(1);
    expect(gateway.revoked.size).toBe(0);
    const registered = hex(gateway.accounts.get("u-1")?.key as Uint8Array);
    // Every copy, the stored one too, keeps the key registered.
    for (const doc of [...holders.map((h) => h.session.doc), stored?.doc]) {
      const kept = doc && keyringIdentity(doc)?.publicKey;
      expect(kept && hex(kept)).toBe(registered);
    }
  });
});

// Analysis 18r, UK3: the list opened on a second device (a code, an
// association), its attestation asked before its first sync (`use`, then
// `attest`): the copy here holds no key yet, the list at the gateway
// does. The key the list holds must be the one registered, the first
// device's untouched.
describe("the account's list opened on a second device", () => {
  test("the list's key attested, not one drawn before the first sync", async () => {
    const keyrings = new FakeGateway(GATEWAY);
    const keys = await KeysGateway.create();
    // One gateway: its keyrings, its keys.
    const fetch = (url: string, init?: RequestInit) =>
      new URL(url).pathname.startsWith("/accounts/keyring")
        ? keyrings.fetch(url, init)
        : keys.fetch(url, init);
    const device = async () => {
      const token = keyrings.tokenOf("u-1");
      keys.token(token, "u-1", true);
      const local = openKeyringLocal({
        indexedDB: new IDBFactory(),
        lock: memoryLock(),
      });
      await local.keepSignedIn({
        gateway: GATEWAY,
        token,
        deadline: keys.now + 12 * 3600_000,
        recentUntil: keys.now + 600_000,
        name: "u-1",
        email: null,
        issuer: REF.issuer,
        sub: REF.sub,
      });
      const options = sessionOptions(
        {
          local,
          fetch,
          // The first sync goes when the test says (`sync`).
          setTimer: () => () => {},
          account: {
            local,
            openWindow: () => {},
            channel: () => ({ post: () => {}, listen: () => () => {} }),
          },
        },
        "https://collab.test",
      );
      const attestor = (identity: ReturnType<typeof identityKeys>) =>
        Attestor.open({
          gateway: GATEWAY,
          configured: new Set([keys.fingerprint]),
          local,
          fetch,
          now: () => keys.now,
          setTimer: () => () => {},
          accountSigner: (account) => identity.accountSigner(account),
        });
      return { options, attestor };
    };

    // The first device: its list's key drawn, registered, the list synced.
    const first = await device();
    const firstSession = await KeyringSession.adopt(first.options, REF);
    if (!firstSession) throw new Error("not adopted");
    const firstKeys = identityKeys({ keyring: async () => firstSession });
    expect(await (await first.attestor(firstKeys)).refresh()).toBe("attested");
    expect(await firstSession.sync()).toBe("synced");
    const registered = hex(keys.accounts.get("u-1")?.key as Uint8Array);

    // The second device opens the list (a code: `join`), and asks its
    // attestation at once.
    const second = await device();
    const { session } = await KeyringSession.join(second.options, REF);
    if (!session) throw new Error("not joined");
    const secondKeys = identityKeys({ keyring: async () => session });
    const state = await (await second.attestor(secondKeys)).refresh();
    expect(keys.revoked.size).toBe(0);
    expect(hex(keys.accounts.get("u-1")?.key as Uint8Array)).toBe(registered);
    expect(state).toBe("attested");
    expect(await session.sync()).toBe("synced");
    const kept = keyringIdentity(session.doc)?.publicKey;
    expect(kept && hex(kept)).toBe(registered);
  });
});
