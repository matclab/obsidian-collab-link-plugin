// @vitest-environment jsdom
//
// The key a page signs with (phase 18, decision 8; docs/protocol/
// 05-keyring.md, KR-38; analysis 18g): the keyring's when this tab has a
// keyring — drawn and written there if it has none —, else this device's,
// drawn once, kept in IndexedDB, never extractable; two pages drawing at
// once keep one; none at all without Ed25519.
import { IDBFactory } from "fake-indexeddb";
import type { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import {
  type IdentityKey,
  addOwnKey,
  decryptKeyring,
  exportPrivateKey,
  fingerprintOf,
  generateIdentityKey,
  keyringIdentity,
  newKeyringDoc,
  newKeyringSecrets,
  ownKeys,
  readKeyringPlaintext,
  setKeyringIdentity,
} from "../../lib/src/index.js";
import type { KeyringRef } from "../keyring/ref.js";
import { KeyringSession } from "../keyring/session.js";
import { identityKeys, openDeviceKeyStore } from "./identity-keys.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function memoryLocal() {
  // A keyring copy that keeps nothing: the session's doc is what counts.
  return {
    load: async () => undefined,
    // As the stored copy does, the edit applied after the merge (UK1).
    save: async (
      _ref: unknown,
      doc: LoroDoc,
      edit?: (doc: LoroDoc) => void,
    ) => {
      edit?.(doc);
      return "saved" as const;
    },
    replace: async () => {},
    claim: async () => "claimed" as const,
    join: async () => "nothing-here" as const,
    forget: async () => {},
    rotate: async () => "rotated" as const,
    retired: async () => [],
    clearRetired: async () => {},
    successor: async () => undefined,
    // Starting over (analysis 18p.3) is not in this test.
    startOver: async () => "taken" as const,
    startingOver: async () => false,
    clearStartOver: async () => {},
  };
}

const ACCOUNT = {
  gateway: "https://accounts.example",
  issuer: "https://idp.example",
  sub: "u-1",
};

/** A keyring at the server, in memory: its version and blob. */
function memoryServer() {
  const server = {
    stored: { version: 0, blob: new Uint8Array() as Uint8Array },
    reachable: true,
    transport: () => ({
      read: async () => (server.reachable ? server.stored : "missing"),
      write: async (version: number, blob: Uint8Array) => {
        if (!server.reachable) return "missing" as const;
        if (version !== server.stored.version) {
          return { stale: server.stored.version };
        }
        server.stored = { version: version + 1, blob };
        return { written: version + 1 };
      },
    }),
  };
  return server;
}

async function keyringSession(
  ref: KeyringRef = { keyringId: "ab".repeat(16), ...newKeyringSecrets() },
  server = memoryServer(),
  local: ReturnType<typeof memoryLocal> = memoryLocal(),
): Promise<KeyringSession> {
  const credentials = ref;
  const session = await KeyringSession.adopt(
    {
      local,
      transport: server.transport,
      remove: async () => "missing",
      setTimer: () => () => {},
    },
    credentials,
    newKeyringDoc(),
  );
  if (!session) throw new Error("no session");
  return session;
}

describe("the key a page signs with", () => {
  test("without a keyring: this device's, drawn once, kept, not extractable", async () => {
    const indexedDB = new IDBFactory();
    const keys = identityKeys({ device: openDeviceKeyStore(indexedDB) });
    const [a, b] = await Promise.all([keys.signer(), keys.signer()]);
    expect(a && hex(a.publicKey)).toBe(b && hex(b.publicKey));
    expect(a?.privateKey.extractable).toBe(false);
    // Another page of this device: the same key.
    const again = await identityKeys({
      device: openDeviceKeyStore(indexedDB),
    }).signer();
    expect(again && hex(again.publicKey)).toBe(a && hex(a.publicKey));
  });

  test("two pages drawing at once keep one key", async () => {
    const indexedDB = new IDBFactory();
    const [a, b] = await Promise.all([
      identityKeys({ device: openDeviceKeyStore(indexedDB) }).signer(),
      identityKeys({ device: openDeviceKeyStore(indexedDB) }).signer(),
    ]);
    expect(a && hex(a.publicKey)).toBe(b && hex(b.publicKey));
  });

  test("KR-38: with a keyring, its key — drawn and written there if it has none", async () => {
    const session = await keyringSession();
    const indexedDB = new IDBFactory();
    const keys = identityKeys({
      device: openDeviceKeyStore(indexedDB),
      keyring: async () => session,
    });
    const signer = await keys.signer();
    const held = keyringIdentity(session.doc);
    expect(held && hex(held.publicKey)).toBe(signer && hex(signer.publicKey));
    // The device's own, if any, isn't the one used.
    const device = await identityKeys({
      device: openDeviceKeyStore(indexedDB),
    }).signer();
    expect(device && hex(device.publicKey)).not.toBe(
      signer && hex(signer.publicKey),
    );
    expect((await keys.signer())?.publicKey).toEqual(signer?.publicKey);
  });

  test("the keyring's key changed (merged from another device): the new one is used", async () => {
    const session = await keyringSession();
    const keys = identityKeys({ keyring: async () => session });
    const first = await keys.signer();
    const other = await generateIdentityKey({ extractable: true });
    const { exportPrivateKey, setKeyringIdentity } = await import(
      "../../lib/src/index.js"
    );
    setKeyringIdentity(
      session.doc,
      await exportPrivateKey(other.privateKey),
      other.publicKey,
    );
    const second = await keys.signer();
    expect(second?.publicKey).toEqual(other.publicKey);
    expect(second?.publicKey).not.toEqual(first?.publicKey);
  });

  test("a keyring key whose halves don't match is not used", async () => {
    const session = await keyringSession();
    const a = await generateIdentityKey({ extractable: true });
    const b = await generateIdentityKey();
    const { exportPrivateKey, setKeyringIdentity } = await import(
      "../../lib/src/index.js"
    );
    setKeyringIdentity(
      session.doc,
      await exportPrivateKey(a.privateKey),
      b.publicKey,
    );
    const indexedDB = new IDBFactory();
    const keys = identityKeys({
      device: openDeviceKeyStore(indexedDB),
      keyring: async () => session,
    });
    const used = await keys.signer();
    expect(used?.publicKey).not.toEqual(b.publicKey);
    expect(used?.publicKey).not.toEqual(a.publicKey);
  });

  test("without Ed25519 nor a device store: nothing to sign with", async () => {
    const failing = async (): Promise<IdentityKey> => {
      throw new Error("Ed25519 unsupported");
    };
    expect(
      await identityKeys({
        device: openDeviceKeyStore(new IDBFactory()),
        generate: failing,
      }).signer(),
    ).toBeUndefined();
    expect(await identityKeys({}).signer()).toBeUndefined();
  });
});

// SG2, analysis 18k: what a gateway may attest is the key of the
// account's keyring, of that account only; never the device's.
describe("the key of an account's keyring", () => {
  test("the tab's keyring's, if it is that account's", async () => {
    const session = await keyringSession({
      ...ACCOUNT,
      key: new Uint8Array(32).fill(1),
    });
    const keys = identityKeys({ keyring: async () => session });
    const signer = await keys.accountSigner(ACCOUNT);
    expect(signer && hex(signer.publicKey)).toBe(
      hex(keyringIdentity(session.doc)?.publicKey as Uint8Array),
    );
    expect(hex((await keys.signer())?.publicKey as Uint8Array)).toBe(
      hex(signer?.publicKey as Uint8Array),
    );
    for (const other of [
      { ...ACCOUNT, sub: "u-2" },
      { ...ACCOUNT, issuer: "https://other.example" },
      { ...ACCOUNT, gateway: "https://elsewhere.example" },
    ]) {
      expect(
        await keys.accountSigner(other),
        JSON.stringify(other),
      ).toBeUndefined();
    }
  });

  // Analysis 18r, UK4: a key drawn for an account's list only once the
  // page read it from the server — never while it can't.
  test("UK4: the server out of reach, no key drawn for the account's list", async () => {
    const server = memoryServer();
    server.reachable = false;
    const session = await keyringSession(
      { ...ACCOUNT, key: new Uint8Array(32).fill(1) },
      server,
    );
    const keys = identityKeys({ keyring: async () => session });
    expect(await keys.accountSigner(ACCOUNT)).toBeUndefined();
    expect(keyringIdentity(session.doc)).toBeNull();
    // Reached again: the next ask draws it.
    server.reachable = true;
    expect(await keys.accountSigner(ACCOUNT)).toBeDefined();
    expect(keyringIdentity(session.doc)).not.toBeNull();
  });

  // UK5: the key drawn is at the server before it is given.
  test("UK5: the account's list's key drawn, pushed, then given", async () => {
    const server = memoryServer();
    const ref = { ...ACCOUNT, key: new Uint8Array(32).fill(1) };
    const session = await keyringSession(ref, server);
    const keys = identityKeys({ keyring: async () => session });
    const signer = await keys.accountSigner(ACCOUNT);
    const atServer = readKeyringPlaintext(
      await decryptKeyring(ref.key, server.stored.blob),
    );
    expect(
      hex(keyringIdentity(atServer as LoroDoc)?.publicKey as Uint8Array),
    ).toBe(hex(signer?.publicKey as Uint8Array));
  });

  test("none for a keyring link's, nor for the device's key", async () => {
    const session = await keyringSession();
    const idb = new IDBFactory();
    const keys = identityKeys({
      device: openDeviceKeyStore(idb),
      keyring: async () => session,
    });
    expect(await keys.accountSigner(ACCOUNT)).toBeUndefined();
    const deviceOnly = identityKeys({
      device: openDeviceKeyStore(new IDBFactory()),
      keyring: async () => undefined,
    });
    expect(await deviceOnly.signer()).toBeDefined();
    expect(await deviceOnly.accountSigner(ACCOUNT)).toBeUndefined();
  });
});

// The other keys a page signed with, kept in the keyring (KR-46, ADR-0050
// §3, AF6): its person's devices then know them as theirs.
describe("the other keys, in the keyring", () => {
  test("the device's key, drawn before the keyring was used, is added once", async () => {
    const idb = new IDBFactory();
    const before = await identityKeys({
      device: openDeviceKeyStore(idb),
    }).signer();
    const session = await keyringSession();
    const keys = identityKeys({
      device: openDeviceKeyStore(idb),
      keyring: async () => session,
      now: () => 1234,
    });
    const signer = await keys.signer();
    expect(hex(signer?.publicKey as Uint8Array)).toBe(
      hex(keyringIdentity(session.doc)?.publicKey as Uint8Array),
    );
    expect(ownKeys(session.doc).map(hex)).toEqual([
      hex(before?.publicKey as Uint8Array),
    ]);
    const version = session.doc.oplogVersion();
    await keys.signer();
    await identityKeys({
      device: openDeviceKeyStore(idb),
      keyring: async () => session,
    }).signer();
    expect(session.doc.oplogVersion().compare(version)).toBe(0);
  });

  test("no device key drawn: none drawn to be added", async () => {
    const idb = new IDBFactory();
    const session = await keyringSession();
    await identityKeys({
      device: openDeviceKeyStore(idb),
      keyring: async () => session,
    }).signer();
    expect(ownKeys(session.doc)).toEqual([]);
    // Still none kept on the device.
    expect(await openDeviceKeyStore(idb).peek()).toBeUndefined();
  });

  test("the keyring's key a merge replaced is added, the new one isn't", async () => {
    const session = await keyringSession();
    const keys = identityKeys({ keyring: async () => session });
    const first = await keys.signer();
    const other = await generateIdentityKey({ extractable: true });
    setKeyringIdentity(
      session.doc,
      await exportPrivateKey(other.privateKey),
      other.publicKey,
    );
    await keys.signer();
    expect(ownKeys(session.doc).map(hex)).toEqual([
      hex(first?.publicKey as Uint8Array),
    ]);
  });
});

// Who « I » am, by my keys (ADR-0050 §2): the key signed with now, this
// device's, the keyring's `keys`; told when the keyring changes.
describe("my fingerprints", () => {
  const fp = (key: Uint8Array) => hex(fingerprintOf(key));

  test("the device's alone, without a keyring", async () => {
    const keys = identityKeys({ device: openDeviceKeyStore(new IDBFactory()) });
    const signer = await keys.signer();
    expect(await keys.fingerprints()).toEqual([
      fp(signer?.publicKey as Uint8Array),
    ]);
  });

  test("with a keyring: its key, the device's, those of `keys`; told when `keys` changes", async () => {
    const idb = new IDBFactory();
    const device = await identityKeys({
      device: openDeviceKeyStore(idb),
    }).signer();
    const session = await keyringSession();
    const keys = identityKeys({
      device: openDeviceKeyStore(idb),
      keyring: async () => session,
    });
    const signer = await keys.signer();
    let told = 0;
    const stop = await keys.subscribe(() => told++);
    const other = await generateIdentityKey();
    await session.change((doc) => addOwnKey(doc, other.publicKey, 1));
    expect(told).toBeGreaterThan(0);
    expect((await keys.fingerprints()).sort()).toEqual(
      [
        fp(signer?.publicKey as Uint8Array),
        fp(device?.publicKey as Uint8Array),
        fp(other.publicKey),
      ].sort(),
    );
    stop();
  });

  test("no key at all: none", async () => {
    expect(await identityKeys({}).fingerprints()).toEqual([]);
  });
});

// Phase 30, NK3: the attestation is judged again when the list's key
// changes (merged from another device that replaced it), and only then.
describe("told when the keyring's key changes (phase 30, NK3)", () => {
  test("told once per new key, not for another change of the list", async () => {
    const session = await keyringSession();
    const keys = identityKeys({ keyring: async () => session });
    await keys.signer();
    let told = 0;
    const stop = await keys.subscribeKey(() => told++);
    const other = await generateIdentityKey({ extractable: true });
    await session.change((doc) => addOwnKey(doc, other.publicKey, 1));
    expect(told).toBe(0);
    await session.change((doc) =>
      setKeyringIdentity(doc, new Uint8Array(), other.publicKey),
    );
    // A value of another form is no key (KR-38): a change all the same.
    expect(told).toBe(1);
    const pkcs8 = await exportPrivateKey(other.privateKey);
    await session.change((doc) =>
      setKeyringIdentity(doc, pkcs8, other.publicKey),
    );
    expect(told).toBe(2);
    await session.change((doc) => addOwnKey(doc, new Uint8Array(32), 2));
    expect(told).toBe(2);
    stop();
    const third = await generateIdentityKey({ extractable: true });
    const thirdPkcs8 = await exportPrivateKey(third.privateKey);
    await session.change((doc) =>
      setKeyringIdentity(doc, thirdPkcs8, third.publicKey),
    );
    expect(told).toBe(2);
  });

  test("without a keyring: never told", async () => {
    const keys = identityKeys({});
    expect(typeof (await keys.subscribeKey(() => {}))).toBe("function");
  });
});

/** The list at the server, as `key` reads it. */
async function atServer(
  server: ReturnType<typeof memoryServer>,
  key: Uint8Array,
) {
  return readKeyringPlaintext(
    await decryptKeyring(key, server.stored.blob),
  ) as LoroDoc;
}

// Phase 30, NK4 (ADR-0056 §3, KR-47): the refused key replaced, only if
// the list, synced and merged with the stored copy, still holds it; kept
// in `keys`; the list pushed.
describe("a refused key replaced (phase 30, NK4)", () => {
  const ref = { ...ACCOUNT, key: new Uint8Array(32).fill(1) };

  test("drawn: written over the refused key, which goes to `keys`; pushed", async () => {
    const server = memoryServer();
    const session = await keyringSession(ref, server);
    const keys = identityKeys({ keyring: async () => session, now: () => 5 });
    const refused = (await keys.accountSigner(ACCOUNT))
      ?.publicKey as Uint8Array;
    expect(await keys.replaceRefused(ACCOUNT, refused)).toBe("drawn");
    const now = keyringIdentity(session.doc)?.publicKey as Uint8Array;
    expect(hex(now)).not.toBe(hex(refused));
    expect(ownKeys(session.doc).map(hex)).toContain(hex(refused));
    const pushed = await atServer(server, ref.key);
    expect(hex(keyringIdentity(pushed)?.publicKey as Uint8Array)).toBe(
      hex(now),
    );
    expect(ownKeys(pushed).map(hex)).toContain(hex(refused));
    expect(
      hex((await keys.accountSigner(ACCOUNT))?.publicKey as Uint8Array),
    ).toBe(hex(now));
  });

  test("offline: nothing drawn", async () => {
    const server = memoryServer();
    const session = await keyringSession(ref, server);
    const keys = identityKeys({ keyring: async () => session });
    const refused = (await keys.accountSigner(ACCOUNT))
      ?.publicKey as Uint8Array;
    server.reachable = false;
    expect(await keys.replaceRefused(ACCOUNT, refused)).toBe("offline");
    expect(hex(keyringIdentity(session.doc)?.publicKey as Uint8Array)).toBe(
      hex(refused),
    );
  });

  test("the list holds another key once synced: nothing written", async () => {
    const server = memoryServer();
    const session = await keyringSession(ref, server);
    const keys = identityKeys({ keyring: async () => session });
    const refused = (await keys.accountSigner(ACCOUNT))
      ?.publicKey as Uint8Array;
    // Another device replaced it, and pushed: read by the first sync.
    const other = await generateIdentityKey({ extractable: true });
    const pkcs8 = await exportPrivateKey(other.privateKey);
    const elsewhere = await keyringSession(ref, server);
    await elsewhere.sync();
    await elsewhere.change((doc) =>
      setKeyringIdentity(doc, pkcs8, other.publicKey),
    );
    await elsewhere.sync();
    expect(await keys.replaceRefused(ACCOUNT, refused)).toBe("replaced");
    expect(hex(keyringIdentity(session.doc)?.publicKey as Uint8Array)).toBe(
      hex(other.publicKey),
    );
  });

  test("another holder of the device wrote one under the lock first: nothing written over it", async () => {
    const other = await generateIdentityKey({ extractable: true });
    const pkcs8 = await exportPrivateKey(other.privateKey);
    const local = memoryLocal();
    let elsewhere = false;
    const save = local.save;
    local.save = async (r, doc, edit) => {
      // The stored copy, merged before the edit, holds the other's key.
      if (edit && elsewhere) setKeyringIdentity(doc, pkcs8, other.publicKey);
      return save(r, doc, edit);
    };
    const session = await keyringSession(ref, memoryServer(), local);
    const keys = identityKeys({ keyring: async () => session });
    const refused = (await keys.accountSigner(ACCOUNT))
      ?.publicKey as Uint8Array;
    elsewhere = true;
    expect(await keys.replaceRefused(ACCOUNT, refused)).toBe("replaced");
    expect(hex(keyringIdentity(session.doc)?.publicKey as Uint8Array)).toBe(
      hex(other.publicKey),
    );
    expect(ownKeys(session.doc).map(hex)).not.toContain(hex(refused));
  });

  test("none for a keyring link's, nor for another account's", async () => {
    const link = await keyringSession();
    const keys = identityKeys({ keyring: async () => link });
    const signer = await keys.signer();
    expect(
      await keys.replaceRefused(ACCOUNT, signer?.publicKey as Uint8Array),
    ).toBe("none");
    const session = await keyringSession(ref);
    const mine = identityKeys({ keyring: async () => session });
    const refused = (await mine.accountSigner(ACCOUNT))
      ?.publicKey as Uint8Array;
    expect(await mine.replaceRefused({ ...ACCOUNT, sub: "u-2" }, refused)).toBe(
      "none",
    );
    expect(hex(keyringIdentity(session.doc)?.publicKey as Uint8Array)).toBe(
      hex(refused),
    );
  });
});

// Phase 30, NK5 (ADR-0056 §4): a key is given to register only from the
// list as synced now — what it wrote at the server first.
describe("the key to register (phase 30, NK5)", () => {
  const ref = { ...ACCOUNT, key: new Uint8Array(32).fill(1) };

  test("synced now and still the list's: registrable; offline or another: not", async () => {
    const server = memoryServer();
    const session = await keyringSession(ref, server);
    const keys = identityKeys({ keyring: async () => session });
    const signer = await keys.accountSigner(ACCOUNT);
    const key = signer?.publicKey as Uint8Array;
    // Written here, not pushed: a page reloaded before its push.
    const next = await generateIdentityKey({ extractable: true });
    const pkcs8 = await exportPrivateKey(next.privateKey);
    server.reachable = false;
    await session.change((doc) =>
      setKeyringIdentity(doc, pkcs8, next.publicKey),
    );
    expect(await keys.registrable(ACCOUNT, next.publicKey)).toBe(false);
    server.reachable = true;
    expect(await keys.registrable(ACCOUNT, key)).toBe(false);
    expect(await keys.registrable(ACCOUNT, next.publicKey)).toBe(true);
    expect(
      hex(
        keyringIdentity(await atServer(server, ref.key))
          ?.publicKey as Uint8Array,
      ),
    ).toBe(hex(next.publicKey));
    expect(
      await keys.registrable({ ...ACCOUNT, sub: "u-2" }, next.publicKey),
    ).toBe(false);
  });
});
