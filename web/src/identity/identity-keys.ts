/** The key a page signs with: the
 * keyring's when this tab has one (docs/protocol/05-keyring.md, KR-38),
 * drawn and written there if it has none; else this device's, drawn once,
 * kept in IndexedDB, never extractable. None without Ed25519, nor without
 * anywhere to keep a key: a key drawn at each opening would show the same
 * name under a new fingerprint every time (ID-17). With a keyring, the
 * other keys it may have signed with are added to its `keys` (KR-46,
 * ADR-0050 §3). The key of an account's list the gateway refused is
 * replaced on its user's request (KR-47, ADR-0056), and a key is given to
 * register only from the list as synced then (NK5). */
import {
  type IdentityKey,
  type Signer,
  addOwnKey,
  exportPrivateKey,
  fingerprintOf,
  generateIdentityKey,
  importIdentityKey,
  keyringIdentity,
  ownKeys,
  setKeyringIdentity,
  signerOf,
} from "../../lib/src/index.js";
import { isAccountKeyring } from "../keyring/ref.js";
import type { KeyringSession } from "../keyring/session.js";

/** This device's key, in IndexedDB. */
export interface DeviceKeyStore {
  /** The key kept, or `draw`'s, kept now — unless another page kept one
   * first: then that one. */
  get(draw: () => Promise<IdentityKey>): Promise<IdentityKey>;
  /** The key kept, if any; never draws one. */
  peek(): Promise<IdentityKey | undefined>;
}

const BASE = "oc:identity";
const STORE = "key";
const ENTRY = "ed25519";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** The device's key in `indexedDB`, base `oc:identity`; `namespace` as
 * the documents' records (the plugin's, one per vault). A key is added,
 * never replaced: of two pages drawing at once, the second's `add` fails,
 * and it reads the first's. */
export function openDeviceKeyStore(
  indexedDB: IDBFactory,
  namespace?: string,
): DeviceKeyStore {
  const name = namespace ? `${BASE}:${namespace}` : BASE;
  let opening: Promise<IDBDatabase> | undefined;
  const db = () => {
    opening ??= (() => {
      const open = indexedDB.open(name, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE);
      return request(open);
    })();
    return opening;
  };
  const read = async (): Promise<IdentityKey | undefined> => {
    const store = (await db()).transaction(STORE).objectStore(STORE);
    const held: unknown = await request(store.get(ENTRY));
    if (typeof held !== "object" || held === null) return undefined;
    const { privateKey, publicKey } = held as Record<string, unknown>;
    return privateKey instanceof CryptoKey && ArrayBuffer.isView(publicKey)
      ? {
          privateKey,
          publicKey: new Uint8Array(
            publicKey.buffer,
            publicKey.byteOffset,
            publicKey.byteLength,
          ).slice(),
        }
      : undefined;
  };
  return {
    peek: read,
    async get(draw) {
      const held = await read();
      if (held) return held;
      const drawn = await draw();
      try {
        const transaction = (await db()).transaction(STORE, "readwrite");
        await request(transaction.objectStore(STORE).add(drawn, ENTRY));
      } catch {
        // Another page added one first.
        const first = await read();
        if (first) return first;
        throw new Error("the device's key couldn't be kept");
      }
      return drawn;
    },
  };
}

export interface IdentityKeys {
  /** The key to sign with now, or `undefined`. */
  signer(): Promise<Signer | undefined>;
  /** The key of the tab's keyring if it is `account`'s list (KR-38): the
   * only key a gateway may attest for it (SG2). Never the
   * device's. */
  accountSigner(account: {
    gateway: string;
    issuer: string;
    sub: string;
  }): Promise<Signer | undefined>;
  /** The fingerprints (ID-5), in hexadecimal, of the keys that are mine
   * (ADR-0050 §2): the one signed with now, this device's if drawn, the
   * keyring's `keys` (KR-46). Draws nothing it wouldn't sign with. */
  fingerprints(): Promise<string[]>;
  /** Told when the tab's keyring changes (its `keys` may have); resolves
   * to an unsubscribe. */
  subscribe(listener: () => void): Promise<() => void>;
  /** Told when the tab's keyring's key changes (NK3: merged from a device that
   * replaced it); resolves to an unsubscribe. */
  subscribeKey(listener: () => void): Promise<() => void>;
  /** Replaces `refused`, the key of `account`'s list, by a key drawn now
   * (KR-47, NK4): the list synced first; written, with
   * `refused` in `keys`, only if the list merged with the stored copy
   * still holds it; then pushed. `replaced` if it holds another key (a
   * device replaced it first), `offline` if it couldn't be synced, `none`
   * if the tab's list isn't `account`'s. */
  replaceRefused(
    account: AccountOf,
    refused: Uint8Array,
  ): Promise<"drawn" | "replaced" | "offline" | "none">;
  /** Whether `publicKey` is the key of `account`'s list as synced now
   * (NK5): what this page wrote is at the server before the key
   * is registered. */
  registrable(account: AccountOf, publicKey: Uint8Array): Promise<boolean>;
}

/** An account, as its list names it. */
interface AccountOf {
  gateway: string;
  issuer: string;
  sub: string;
}

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Whether a private and a public key are a pair: a signature of the one
 * verifies under the other. */
async function isPair(key: IdentityKey): Promise<boolean> {
  try {
    const probe = new TextEncoder().encode("oc-key-check");
    const signature = await crypto.subtle.sign(
      { name: "Ed25519" },
      key.privateKey,
      probe,
    );
    const publicKey = await crypto.subtle.importKey(
      "raw",
      key.publicKey as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      publicKey,
      signature,
      probe,
    );
  } catch {
    return false;
  }
}

export function identityKeys(options: {
  device?: DeviceKeyStore;
  /** The tab's keyring, if any. */
  keyring?: () => Promise<KeyringSession | undefined>;
  /** Draws a key (WebCrypto's; injected for a browser without Ed25519). */
  generate?: typeof generateIdentityKey;
  /** When a key is added to `keys` (Unix milliseconds). */
  now?: () => number;
}): IdentityKeys {
  const generate = options.generate ?? generateIdentityKey;
  const now = options.now ?? Date.now;
  /** The keyring's key, by its bytes: imported and checked once. */
  const imported = new Map<string, Promise<Signer | undefined>>();
  let drawing: Promise<void> | undefined;
  let device: Promise<Signer | undefined> | undefined;

  const fromKeyring = async (
    session: KeyringSession,
  ): Promise<Signer | undefined> => {
    if (!keyringIdentity(session.doc)) {
      // One draw at a time: two objects signed at once write one key.
      drawing ??= (async () => {
        const account = isAccountKeyring(session.ref);
        // An account's list read from the server first: another device
        // may have drawn its key (UK4).
        if (account && !session.synced && (await session.sync()) !== "synced")
          return;
        if (keyringIdentity(session.doc)) return;
        const key = await generate({ extractable: true });
        const pkcs8 = await exportPrivateKey(key.privateKey);
        // Under the device's lock, the stored copy merged first: another
        // holder of the list here may have drawn one (UK1).
        const saved = await session.changeStored((doc) => {
          if (!keyringIdentity(doc)) {
            setKeyringIdentity(doc, pkcs8, key.publicKey);
          }
        });
        // Pushed before it is registered: the merge may keep another
        // device's (UK5, KR-38).
        if (account && saved === "saved") await session.sync();
      })().finally(() => {
        drawing = undefined;
      });
      await drawing;
    }
    const held = keyringIdentity(session.doc);
    if (!held) return undefined;
    const name = toHex(held.pkcs8) + toHex(held.publicKey);
    let signer = imported.get(name);
    if (!signer) {
      signer = (async () => {
        const key = await importIdentityKey(held.pkcs8, held.publicKey);
        return (await isPair(key)) ? signerOf(key) : undefined;
      })().catch(() => undefined);
      imported.set(name, signer);
    }
    return signer;
  };

  /** KR-46: the device's key, if one was drawn, and the keyring's keys
   * this page used before the current one, added to `keys` — once per
   * keyring and key signed with. Never draws a key to add it. */
  const remembered = new WeakMap<KeyringSession, Map<string, Promise<void>>>();
  const remember = (session: KeyringSession, current: Signer) => {
    let done = remembered.get(session);
    if (!done) {
      done = new Map();
      remembered.set(session, done);
    }
    const name = toHex(current.publicKey);
    let run = done.get(name);
    if (!run) {
      run = (async () => {
        const others: Uint8Array[] = [];
        const device = await options.device?.peek().catch(() => undefined);
        if (device) others.push(device.publicKey);
        for (const used of usedKeys.values()) others.push(used);
        const added = others.filter((key) => toHex(key) !== name);
        if (added.length === 0) return;
        await session.change((doc) => {
          for (const key of added) addOwnKey(doc, key, now());
        });
      })().catch(() => {
        // Tried again with the next signature.
        done.delete(name);
      });
      done.set(name, run);
    }
    return run;
  };
  /** The keyring's keys this page signed with, by hexadecimal. */
  const usedKeys = new Map<string, Uint8Array>();

  const fromDevice = (): Promise<Signer | undefined> => {
    const store = options.device;
    if (!store) return Promise.resolve(undefined);
    device ??= store
      .get(() => generate({ extractable: false }))
      .then(signerOf)
      .catch(() => {
        device = undefined;
        return undefined;
      });
    return device;
  };

  /** The tab's keyring, if it is `account`'s list. */
  const accountSession = async (
    account: AccountOf,
  ): Promise<KeyringSession | undefined> => {
    const session = await options.keyring?.();
    const ref = session?.ref;
    const same =
      ref !== undefined &&
      isAccountKeyring(ref) &&
      ref.gateway === account.gateway &&
      ref.issuer === account.issuer &&
      ref.sub === account.sub;
    return same ? session : undefined;
  };
  /** Whether the list's key is `publicKey`. */
  const holds = (doc: KeyringSession["doc"], publicKey: Uint8Array) => {
    const held = keyringIdentity(doc);
    return held !== null && toHex(held.publicKey) === toHex(publicKey);
  };

  return {
    async signer() {
      try {
        const session = await options.keyring?.();
        if (session) {
          const signer = await fromKeyring(session);
          if (signer) {
            await remember(session, signer);
            usedKeys.set(toHex(signer.publicKey), signer.publicKey);
            return signer;
          }
        }
      } catch {
        // The keyring's key can't be had: the device's.
      }
      return fromDevice();
    },
    async fingerprints() {
      const keys = new Set<string>();
      const add = (publicKey: Uint8Array) =>
        keys.add(toHex(fingerprintOf(publicKey)));
      const signer = await this.signer();
      if (signer) add(signer.publicKey);
      const device = await options.device?.peek().catch(() => undefined);
      if (device) add(device.publicKey);
      const session = await options.keyring?.().catch(() => undefined);
      if (session) for (const key of ownKeys(session.doc)) add(key);
      return [...keys];
    },
    async subscribe(listener) {
      const session = await options.keyring?.().catch(() => undefined);
      return session ? session.subscribe(listener) : () => {};
    },
    async subscribeKey(listener) {
      const session = await options.keyring?.().catch(() => undefined);
      if (!session) return () => {};
      const keyOf = () => {
        const held = keyringIdentity(session.doc);
        return held ? toHex(held.publicKey) : "";
      };
      let key = keyOf();
      return session.subscribe(() => {
        const next = keyOf();
        if (next === key) return;
        key = next;
        listener();
      });
    },
    async accountSigner(account) {
      try {
        const session = await accountSession(account);
        return session ? await fromKeyring(session) : undefined;
      } catch {
        return undefined;
      }
    },
    async replaceRefused(account, refused) {
      const session = await accountSession(account).catch(() => undefined);
      if (!session) return "none";
      // What another device did is read before deciding (ADR-0056 §3).
      if ((await session.sync()) !== "synced") return "offline";
      if (!holds(session.doc, refused)) return "replaced";
      const key = await generate({ extractable: true });
      const pkcs8 = await exportPrivateKey(key.privateKey);
      let wrote = false;
      // Under the device's lock, the stored copy merged first (UK1): only
      // over the refused key, never over one another holder wrote.
      const saved = await session.changeStored((doc) => {
        if (!holds(doc, refused)) return;
        addOwnKey(doc, refused, now());
        setKeyringIdentity(doc, pkcs8, key.publicKey);
        wrote = true;
      });
      if (saved === "superseded") return "none";
      if (!wrote) return "replaced";
      // Pushed before it is registered (UK5); a failure waits for NK5.
      await session.sync();
      return "drawn";
    },
    async registrable(account, publicKey) {
      const session = await accountSession(account).catch(() => undefined);
      if (!session || (await session.sync()) !== "synced") return false;
      return holds(session.doc, publicKey);
    },
  };
}
