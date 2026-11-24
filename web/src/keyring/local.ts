/** The keyring on this device (docs/phase-18-trousseau-identite.md, decision
 * 5): IndexedDB, base `oc:keyring`, which
 * keyring this device holds (a keyring link, or an account and its `K_t`:
 * `ref.ts`) and the copy encrypted by `K_t`; apart, the account signed in. Each
 * write takes a lock named
 * `oc:keyring` for its own length — not for the tab's life: every tab may
 * write — reads the stored copy, merges it into its own, and stores the
 * result. Two tabs never erase each other's writes (KR-25, locally). */
import type { LoroDoc } from "loro-crdt";
import {
  type KeyringCredentials,
  decryptKeyring,
  encryptKeyring,
  formatKeyringLink,
  listKeyring,
  parseKeyringLink,
  readKeyringPlaintext,
} from "../../lib/src/index.js";
import {
  type AccountKeyring,
  type KeyringRef,
  formatKeyringRef,
  isAccountKeyring,
  linkOf,
  otherAccounts,
  parseKeyringRef,
  sameKeyring,
} from "./ref.js";

/** One holder at a time per name, waiting its turn (`navigator.locks`;
 * injected, jsdom has none). */
export interface KeyringLock {
  exclusive<T>(name: string, run: () => Promise<T>): Promise<T>;
}

/** The Web Locks lock, waiting. */
export function webKeyringLock(locks: LockManager): KeyringLock {
  return {
    exclusive: (name, run) =>
      locks.request(name, () => run()) as Promise<never>,
  };
}

/** The account signed in on this device:
 * its token, until `deadline` on this device's clock (ID-25). */
export interface SignedIn {
  gateway: string;
  token: string;
  deadline: number;
  /** A recent sign-in (ID-28): until when, on this device's clock. */
  recentUntil?: number;
  name: string;
  email: string | null;
  issuer: string;
  sub: string;
}

export interface StoredKeyring {
  /** A keyring link's, or an account's. */
  ref: KeyringRef;
  /** The copy, or `null` if it doesn't decrypt or Loro can't read it. */
  doc: LoroDoc | null;
}

export interface KeyringLocal {
  load(): Promise<StoredKeyring | undefined>;
  /** Merges the stored copy of the same keyring into `doc`, applies
   * `edit` if given — under the lock, after the merge (UK1) —, then stores
   * `doc`. `superseded`: another keyring is stored
   * here now (another tab changed it), nothing written nor applied. */
  save(
    ref: KeyringRef,
    doc: LoroDoc,
    edit?: (doc: LoroDoc) => void,
  ): Promise<"saved" | "superseded">;
  /** Stores this keyring and `doc`, whatever was there: only to replace
   * a keyring known to be gone (cas 12). */
  replace(ref: KeyringRef, doc: LoroDoc): Promise<void>;
  /** Stores this keyring and `doc` if no other keyring is stored here;
   * `taken`: another tab put one meanwhile, nothing written — its key may
   * exist nowhere else. */
  claim(ref: KeyringRef, doc: LoroDoc): Promise<"claimed" | "taken">;
  /** A keyring handed over by another device (KR-37):
   * the copy stored here is merged into `doc`, then this keyring and
   * `doc` are stored — in one write, under the lock. The copy of another
   * keyring is merged only with `merge`, which its user agreed to: else
   * nothing is written (`other`), since whoever holds the keyring given
   * would see every document of it (security review of 18f). An
   * account's list never goes into another account's keyring, even with
   * `merge` (TR7). Says what was here. */
  join(
    ref: KeyringRef,
    doc: LoroDoc,
    options?: { merge?: boolean },
  ): Promise<"nothing-here" | "same" | "merged" | "other">;
  /** Forgets this keyring, and only it: another one stored meanwhile
   * stays. */
  forget(ref: KeyringRef): Promise<void>;
  /** Changing the key (KR-29), or attaching to an account (KR-44): the
   * new keyring and `doc`, with the old one noted to delete, in one
   * write. */
  rotate(
    next: KeyringRef,
    doc: LoroDoc,
    old: KeyringCredentials,
    options?: {
      /** An automatic association (RA1): nothing written if
       * the copy stored holds a document — `not-empty`; `doc`'s own are
       * the tab's, associated with the list. */
      onlyIfEmpty?: boolean;
    },
  ): Promise<"rotated" | "taken" | "not-empty">;
  /** The list that replaced `ref` on this device — by a change of key or
   * an association, never another list put here (RA2) —
   * as it is stored now; none if `ref` wasn't replaced so. */
  successor(ref: KeyringRef): Promise<StoredKeyring | undefined>;
  /** The old keyrings still to delete: every change of key adds one,
   * none is dropped before its deletion (security review of 18e). */
  retired(): Promise<KeyringCredentials[]>;
  /** `old` is deleted: no longer noted. With `ifStored`, only if it is
   * the keyring stored here (a key pasted again made it the list). */
  clearRetired(
    old: KeyringCredentials,
    options?: { ifStored?: boolean },
  ): Promise<void>;
  /** Starting over the identity's list (RL2): if the list
   * stored is still `current` (or none, or already `next`), `next` takes
   * its place and `doc`, the copy stored merged in, in one write, noted as
   * the list that may write over the server's (RL3). A keyring link's
   * `current` is noted to delete (KR-29) and as replaced (RA2). Another
   * list stored: nothing written, `taken`. */
  startOver(
    next: AccountKeyring,
    doc: LoroDoc,
    current?: KeyringRef,
  ): Promise<"started" | "taken">;
  /** Whether `ref` is the list noted by `startOver`, and still stored. */
  startingOver(ref: KeyringRef): Promise<boolean>;
  /** `ref`'s list is on the server (RL3): no longer noted. */
  clearStartOver(ref: KeyringRef): Promise<void>;
}

/** The account signed in on this device, in the same base, apart from the
 * list: forgetting one keeps the other. */
export interface AccountLocal {
  signedIn(): Promise<SignedIn | undefined>;
  keepSignedIn(account: SignedIn): Promise<void>;
  /** Forgets the account of `token`, and only it: one another tab kept
   * meanwhile stays (SI3). */
  forgetSignedIn(token: string): Promise<void>;
  /** The attestation kept on this device: it outlives the
   * token, valid until its end without the gateway (decision 13). */
  attestation(): Promise<KeptAttestation | undefined>;
  keepAttestation(kept: KeptAttestation): Promise<void>;
  /** The account's key the gateway refused to register (`409`, ID-29:
   * revoked, or another account's), kept beside the attestation (NK1):
   * definitive, and found in no revocation list when another
   * account's. One for the device, replaced by the next. */
  refusedKey(): Promise<RefusedKey | undefined>;
  keepRefusedKey(refused: RefusedKey): Promise<void>;
  /** « Plus tard » answered to « Associer ces N documents » by this
   * identity on this device. */
  associationLater(identity: AccountIdentity): Promise<boolean>;
  keepAssociationLater(identity: AccountIdentity): Promise<void>;
  /** The name of an identity whose list was here: said
   * when another identity signs in on this device. */
  identityName(identity: AccountIdentity): Promise<string | undefined>;
  keepIdentityName(identity: AccountIdentity, name: string): Promise<void>;
}

/** An identity, as the account's keyring names it. */
export interface AccountIdentity {
  gateway: string;
  issuer: string;
  sub: string;
}

/** An attestation as this device keeps it: its account, and the envelope,
 * read again (and checked) whenever it is used. */
export interface KeptAttestation {
  gateway: string;
  issuer: string;
  sub: string;
  envelope: Uint8Array;
}

/** A key refused for an account (NK1). */
export interface RefusedKey {
  gateway: string;
  issuer: string;
  sub: string;
  key: Uint8Array;
}

const BASE = "oc:keyring";
const STORE = "keyring";
const LINK = "link";
const COPY = "copy";
const RETIRED = "retired";
const ACCOUNT = "account";
const ATTESTATION = "attestation";
const REFUSED = "refused-key";
const LATER = "association-later";
const NAMES = "identity-names";
/** Which keyring replaced which on this device, by a change of key or an
 * association: from an identifier to the next list's name, no secret;
 * never cleared (RA2). */
const REPLACED = "replaced";
/** The list started over (RL3): its reference, sealed as
 * the link is; only it may write over the server's list, until synced. */
const START_OVER = "start-over";

/** A list's name in `REPLACED`: a keyring's identifier, or its account. */
function nameOf(ref: KeyringRef): string {
  return isAccountKeyring(ref)
    ? `account:${JSON.stringify([ref.gateway, ref.issuer, ref.sub])}`
    : ref.keyringId;
}

/** The keyring's copy in `indexedDB`; `namespace` as the documents'
 * records (the plugin's, one per vault). With `sealKey` (the plugin's,
 * kept in `app.secretStorage`: analysis 18m, M2, OB2), the secrets — the
 * keyring's link or `K_t`, the old links still to delete, the account's
 * token — are stored only sealed by it (AES-GCM), each in the transaction
 * it always had; a record that doesn't open under it is none. The copy is
 * sealed by `K_t` already; the attestation (public, written in documents)
 * and the identities' names stay as they are. */
export function openKeyringLocal(options: {
  indexedDB: IDBFactory;
  lock: KeyringLock;
  namespace?: string;
  sealKey?: Uint8Array;
}): KeyringLocal & AccountLocal {
  const { indexedDB, lock, sealKey } = options;
  /** `value` as stored: sealed, with a key. */
  const seal = async (value: unknown): Promise<unknown> =>
    sealKey
      ? encryptKeyring(sealKey, new TextEncoder().encode(JSON.stringify(value)))
      : value;
  /** A stored value as written, or `undefined` if it doesn't open. */
  const unseal = async (stored: unknown): Promise<unknown> => {
    if (!sealKey) return stored;
    if (!ArrayBuffer.isView(stored)) return undefined;
    try {
      const plain = await decryptKeyring(sealKey, bytesOf(stored));
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(plain),
      );
    } catch {
      return undefined;
    }
  };
  /** What a sealed account is found by, in clear: its token's SHA-256 —
   * the token can't be read back from it. */
  const tokenTag = async (token: string): Promise<string> =>
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
  const name = options.namespace ? `${BASE}:${options.namespace}` : BASE;
  let opening: Promise<IDBDatabase> | undefined;
  const db = () => {
    opening ??= request(
      (() => {
        const open = indexedDB.open(name, 1);
        open.onupgradeneeded = () => open.result.createObjectStore(STORE);
        return open;
      })(),
    );
    return opening;
  };
  const read = async (): Promise<{ link: unknown; copy: unknown }> => {
    const store = (await db()).transaction(STORE).objectStore(STORE);
    const [link, copy] = await Promise.all([
      request(store.get(LINK)),
      request(store.get(COPY)),
    ]);
    return { link: await unseal(link), copy };
  };
  /** The links of the old keyrings still to delete. */
  const retiredLinks = async (): Promise<string[]> => {
    const store = (await db()).transaction(STORE).objectStore(STORE);
    const kept: unknown = await unseal(await request(store.get(RETIRED)));
    return Array.isArray(kept)
      ? kept.filter((l): l is string => typeof l === "string")
      : [];
  };
  /** What `REPLACED` holds. */
  const replacements = async (): Promise<Record<string, string>> => {
    const store = (await db()).transaction(STORE).objectStore(STORE);
    const kept: unknown = await request(store.get(REPLACED));
    if (typeof kept !== "object" || kept === null || Array.isArray(kept)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(kept).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  };
  /** The list noted by `startOver`, if any. */
  const startedOver = async (): Promise<unknown> => {
    const store = (await db()).transaction(STORE).objectStore(STORE);
    return unseal(await request(store.get(START_OVER)));
  };
  const write = async (
    ref: KeyringRef,
    doc: LoroDoc,
    retired?: KeyringCredentials,
    startOver = false,
  ) => {
    const blob = await encryptKeyring(
      ref.key,
      doc.export({ mode: "snapshot" }),
    );
    const before = retired ? await retiredLinks() : [];
    const replaced = retired ? await replacements() : {};
    const text = formatKeyringRef(ref);
    const link = await seal(text);
    // Another list written here: the note of the one started over goes.
    const dropNote = !startOver && (await startedOver()) !== text;
    const old = retired && formatKeyringLink(retired);
    const retiredNow =
      old && (await seal([...before.filter((l) => l !== old), old]));
    // Sealed before: one transaction, as without a key.
    const transaction = (await db()).transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    store.put(link, LINK);
    store.put(blob, COPY);
    if (startOver) store.put(link, START_OVER);
    else if (dropNote) store.delete(START_OVER);
    if (retiredNow) store.put(retiredNow, RETIRED);
    if (retired) {
      store.put({ ...replaced, [retired.keyringId]: nameOf(ref) }, REPLACED);
    }
    await done(transaction);
  };
  const copyOf = async (ref: KeyringRef, copy: unknown) => {
    if (!ArrayBuffer.isView(copy)) return null;
    try {
      return readKeyringPlaintext(await decryptKeyring(ref.key, bytesOf(copy)));
    } catch {
      return null;
    }
  };
  return {
    async load() {
      const { link, copy } = await read();
      if (typeof link !== "string") return undefined;
      let ref: KeyringRef;
      try {
        ref = parseKeyringRef(link);
      } catch {
        return undefined;
      }
      return { ref, doc: await copyOf(ref, copy) };
    },
    save: (ref, doc, edit) =>
      lock.exclusive(name, async () => {
        const { link, copy } = await read();
        if (typeof link === "string" && link !== formatKeyringRef(ref)) {
          return "superseded";
        }
        const stored = await copyOf(ref, copy);
        // A copy that doesn't read is replaced: it holds nothing this
        // device can use, and `doc` holds all it knew.
        if (stored)
          doc.import(
            stored.export({ mode: "update", from: doc.oplogVersion() }),
          );
        edit?.(doc);
        await write(ref, doc);
        return "saved";
      }),
    replace: (ref, doc) => lock.exclusive(name, () => write(ref, doc)),
    claim: (ref, doc) =>
      lock.exclusive(name, async () => {
        const { link } = await read();
        if (typeof link === "string" && link !== formatKeyringRef(ref)) {
          return "taken";
        }
        await write(ref, doc);
        return "claimed";
      }),
    join: (ref, doc, options) =>
      lock.exclusive(name, async () => {
        const { link, copy } = await read();
        let here: KeyringRef | undefined;
        try {
          here = typeof link === "string" ? parseKeyringRef(link) : undefined;
        } catch {}
        const same = here !== undefined && sameKeyring(here, ref);
        if (here && !same && !options?.merge) return "other";
        // TR7: never into another account's keyring, asked or not.
        if (here && otherAccounts(here, ref)) return "other";
        // Whatever reads of it: a copy that doesn't is nothing to lose.
        const stored = here && (await copyOf(here, copy));
        if (stored)
          doc.import(
            stored.export({ mode: "update", from: doc.oplogVersion() }),
          );
        await write(ref, doc);
        if (!here) return "nothing-here";
        return same ? "same" : "merged";
      }),
    rotate: (next, doc, old, options) =>
      lock.exclusive(name, async () => {
        // The keyring stored is still the one changed, or already the
        // next (another tab of this device got there first): its copy is
        // merged into `doc` before `doc` is written — never overwritten
        // by a tab that hasn't read it (TR1).
        // Another one: nothing written.
        const { link, copy } = await read();
        let here: KeyringRef | undefined;
        try {
          here = typeof link === "string" ? parseKeyringRef(link) : undefined;
        } catch {}
        const known =
          here !== undefined &&
          (sameKeyring(here, old) || sameKeyring(here, next));
        if (here && !known) return "taken";
        const stored = here && (await copyOf(here, copy));
        // RA1: decided on the copy, under the lock, not on a tab's view —
        // what the tab added since it judged is associated with the list
        //.
        if (options?.onlyIfEmpty && stored && listKeyring(stored).length > 0) {
          return "not-empty";
        }
        if (stored)
          doc.import(
            stored.export({ mode: "update", from: doc.oplogVersion() }),
          );
        await write(next, doc, old);
        return "rotated";
      }),
    startOver: (next, doc, current) =>
      lock.exclusive(name, async () => {
        // As `rotate`: never over a list another tab put here meanwhile.
        const { link, copy } = await read();
        let here: KeyringRef | undefined;
        try {
          here = typeof link === "string" ? parseKeyringRef(link) : undefined;
        } catch {}
        const known =
          here === undefined ||
          (current !== undefined && sameKeyring(here, current)) ||
          sameKeyring(here, next);
        if (!known) return "taken";
        const stored = here && (await copyOf(here, copy));
        if (stored)
          doc.import(
            stored.export({ mode: "update", from: doc.oplogVersion() }),
          );
        const retired =
          here && !isAccountKeyring(here) ? linkOf(here) : undefined;
        await write(next, doc, retired, true);
        return "started";
      }),
    async startingOver(ref) {
      const text = formatKeyringRef(ref);
      const { link } = await read();
      return link === text && (await startedOver()) === text;
    },
    clearStartOver: (ref) =>
      lock.exclusive(name, async () => {
        if ((await startedOver()) !== formatKeyringRef(ref)) return;
        const transaction = (await db()).transaction(STORE, "readwrite");
        transaction.objectStore(STORE).delete(START_OVER);
        await done(transaction);
      }),
    async successor(ref) {
      if (isAccountKeyring(ref)) return undefined;
      const { link, copy } = await read();
      if (typeof link !== "string") return undefined;
      let here: KeyringRef;
      try {
        here = parseKeyringRef(link);
      } catch {
        return undefined;
      }
      if (sameKeyring(here, ref)) return undefined;
      // Only along what replaced what, to the list stored: never a list
      // put here otherwise (KR-37).
      const replaced = await replacements();
      const target = nameOf(here);
      let at = ref.keyringId;
      for (let hops = 0; hops < 64; hops++) {
        const next = replaced[at];
        if (next === undefined) return undefined;
        if (next === target)
          return { ref: here, doc: await copyOf(here, copy) };
        at = next;
      }
      return undefined;
    },
    async retired() {
      return (await retiredLinks()).flatMap((link) => {
        try {
          return [parseKeyringLink(link)];
        } catch {
          return [];
        }
      });
    },
    clearRetired: (old, options) =>
      lock.exclusive(name, async () => {
        if (options?.ifStored) {
          const { link: stored } = await read();
          if (stored !== formatKeyringRef(old)) return;
        }
        const link = formatKeyringLink(old);
        const left = await seal(
          (await retiredLinks()).filter((l) => l !== link),
        );
        const transaction = (await db()).transaction(STORE, "readwrite");
        transaction.objectStore(STORE).put(left, RETIRED);
        await done(transaction);
      }),
    forget: (ref) =>
      lock.exclusive(name, async () => {
        const { link } = await read();
        if (link !== formatKeyringRef(ref)) return;
        const transaction = (await db()).transaction(STORE, "readwrite");
        const store = transaction.objectStore(STORE);
        for (const key of [LINK, COPY, RETIRED, START_OVER]) store.delete(key);
        await done(transaction);
      }),
    async signedIn() {
      const store = (await db()).transaction(STORE).objectStore(STORE);
      const kept: unknown = await request(store.get(ACCOUNT));
      if (!sealKey) return signedInOf(kept);
      if (typeof kept !== "object" || kept === null) return undefined;
      const account = signedInOf(
        await unseal((kept as Record<string, unknown>).sealed),
      );
      // Found by its tag, read by its seal: the two must agree.
      const tag = (kept as Record<string, unknown>).tag;
      return account && tag === (await tokenTag(account.token))
        ? account
        : undefined;
    },
    async keepSignedIn(account) {
      const record = sealKey
        ? {
            sealed: await seal({ ...account }),
            tag: await tokenTag(account.token),
          }
        : { ...account };
      const transaction = (await db()).transaction(STORE, "readwrite");
      transaction.objectStore(STORE).put(record, ACCOUNT);
      await done(transaction);
    },
    async forgetSignedIn(token) {
      // Before the transaction, which can't wait for WebCrypto.
      const tag = sealKey && (await tokenTag(token));
      // Read and deleted in one transaction: no other write between.
      const transaction = (await db()).transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      const kept = store.get(ACCOUNT);
      kept.onsuccess = () => {
        const record = kept.result as Record<string, unknown> | undefined;
        const same = tag
          ? typeof record === "object" && record?.tag === tag
          : signedInOf(record)?.token === token;
        if (same) store.delete(ACCOUNT);
      };
      await done(transaction);
    },
    async attestation() {
      const store = (await db()).transaction(STORE).objectStore(STORE);
      return keptAttestationOf(await request(store.get(ATTESTATION)));
    },
    async keepAttestation(kept) {
      const transaction = (await db()).transaction(STORE, "readwrite");
      transaction.objectStore(STORE).put({ ...kept }, ATTESTATION);
      await done(transaction);
    },
    async refusedKey() {
      const store = (await db()).transaction(STORE).objectStore(STORE);
      return refusedKeyOf(await request(store.get(REFUSED)));
    },
    async keepRefusedKey(refused) {
      const transaction = (await db()).transaction(STORE, "readwrite");
      transaction.objectStore(STORE).put({ ...refused }, REFUSED);
      await done(transaction);
    },
    async associationLater(identity) {
      const store = (await db()).transaction(STORE).objectStore(STORE);
      const kept = await request(store.get(LATER));
      return typeof kept === "string" && kept === identityKey(identity);
    },
    async identityName(identity) {
      const store = (await db()).transaction(STORE).objectStore(STORE);
      const names = await request(store.get(NAMES));
      if (typeof names !== "object" || names === null) return undefined;
      const name = (names as Record<string, unknown>)[identityKey(identity)];
      return typeof name === "string" ? name : undefined;
    },
    async keepIdentityName(identity, name) {
      // Read and written in one transaction: no other write between.
      const transaction = (await db()).transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      const kept = store.get(NAMES);
      kept.onsuccess = () => {
        const names =
          typeof kept.result === "object" && kept.result !== null
            ? (kept.result as Record<string, string>)
            : {};
        store.put({ ...names, [identityKey(identity)]: name }, NAMES);
      };
      await done(transaction);
    },
    async keepAssociationLater(identity) {
      const transaction = (await db()).transaction(STORE, "readwrite");
      transaction.objectStore(STORE).put(identityKey(identity), LATER);
      await done(transaction);
    },
  };
}

/** One text per identity: its gateway, provider and subject. */
function identityKey(identity: AccountIdentity): string {
  return JSON.stringify([identity.gateway, identity.issuer, identity.sub]);
}

/** A record of `KeptAttestation`'s form, or `undefined`. */
function keptAttestationOf(value: unknown): KeptAttestation | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { gateway, issuer, sub, envelope } = value as Record<string, unknown>;
  if (![gateway, issuer, sub].every((text) => typeof text === "string")) {
    return undefined;
  }
  if (!ArrayBuffer.isView(envelope)) return undefined;
  return {
    gateway,
    issuer,
    sub,
    envelope: bytesOf(envelope).slice(),
  } as KeptAttestation;
}

/** A record of `RefusedKey`'s form, or `undefined`. */
function refusedKeyOf(value: unknown): RefusedKey | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { gateway, issuer, sub, key } = value as Record<string, unknown>;
  if (![gateway, issuer, sub].every((text) => typeof text === "string")) {
    return undefined;
  }
  if (!ArrayBuffer.isView(key) || key.byteLength !== 32) return undefined;
  return { gateway, issuer, sub, key: bytesOf(key).slice() } as RefusedKey;
}

/** A record of `SignedIn`'s form, or `undefined`. */
function signedInOf(value: unknown): SignedIn | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { gateway, token, deadline, recentUntil, name, email, issuer, sub } =
    value as Record<string, unknown>;
  const texts = [gateway, token, name, issuer, sub];
  if (!texts.every((text) => typeof text === "string")) return undefined;
  if (typeof deadline !== "number" || !Number.isFinite(deadline)) {
    return undefined;
  }
  if (email !== null && typeof email !== "string") return undefined;
  if (
    recentUntil !== undefined &&
    (typeof recentUntil !== "number" || !Number.isFinite(recentUntil))
  ) {
    return undefined;
  }
  return {
    gateway,
    token,
    deadline,
    ...(recentUntil !== undefined && { recentUntil }),
    name,
    email,
    issuer,
    sub,
  } as SignedIn;
}

/** A plain `Uint8Array` over any view — one of another realm too
 * (`fake-indexeddb` under jsdom). */
function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("transaction aborted"));
  });
}
