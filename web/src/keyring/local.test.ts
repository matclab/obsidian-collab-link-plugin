// The keyring's copy on this device (docs/phase-18-trousseau-identite.md,
// analysis 18d; decision 5): IndexedDB under fake-indexeddb. A save merges
// what another tab stored first; the copy is never in clear; a copy of
// another keyring isn't overwritten by a save, only by a replacement.
// Each test runs twice: as the page keeps its records, and as the plugin
// does, its secrets sealed by a key of the device (analysis 18m, M2, OB2).
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, test } from "vitest";
import {
  type KeyringCredentials,
  bytesToBase64Url,
  formatKeyringLink,
  listKeyring,
  newKeyringDoc,
  newKeyringSecrets,
  rememberLink,
} from "../../lib/src/index.js";
import { type KeyringLock, openKeyringLocal } from "./local.js";

const KEY = bytesToBase64Url(new Uint8Array(32).fill(0xa0));
const link = (doc: string) =>
  `https://h/?doc=${doc}#k=${KEY}&r=edit.${bytesToBase64Url(new Uint8Array(32).fill(doc.length))}`;

/** One holder at a time per name, in arrival order. */
function memoryLock(): KeyringLock {
  const tails = new Map<string, Promise<unknown>>();
  return {
    exclusive(name, run) {
      const before = tails.get(name) ?? Promise.resolve();
      const result = before.then(run, run);
      tails.set(
        name,
        result.catch(() => {}),
      );
      return result;
    },
  };
}

const credentials = (id = "ab".repeat(16)): KeyringCredentials => ({
  keyringId: id,
  ...newKeyringSecrets(),
});

const SEAL = new Uint8Array(32).fill(0x5e);

async function rawValues(idb: IDBFactory): Promise<unknown[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = idb.open("oc:keyring");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return new Promise((resolve) => {
    const request = db.transaction("keyring").objectStore("keyring").getAll();
    request.onsuccess = () => resolve(request.result);
  });
}

describe.each([
  { mode: "the page's records", sealKey: undefined },
  { mode: "the plugin's records, sealed", sealKey: SEAL },
])("$mode", ({ sealKey }) => {
  const openLocal = (options: Parameters<typeof openKeyringLocal>[0]) =>
    openKeyringLocal(sealKey ? { ...options, sealKey } : options);

  describe("the keyring's copy on this device", () => {
    test("nothing stored: nothing loaded", async () => {
      const local = openLocal({
        indexedDB: new IDBFactory(),
        lock: memoryLock(),
      });
      expect(await local.load()).toBeUndefined();
    });

    test("a replaced keyring loads back, its copy encrypted", async () => {
      const idb = new IDBFactory();
      const local = openLocal({ indexedDB: idb, lock: memoryLock() });
      const mine = credentials();
      const doc = newKeyringDoc();
      rememberLink(doc, link("d1"), { at: 1 });
      await local.replace(mine, doc);
      const loaded = await openLocal({
        indexedDB: idb,
        lock: memoryLock(),
      }).load();
      expect(loaded?.ref.keyringId).toBe(mine.keyringId);
      expect(
        listKeyring(loaded?.doc ?? newKeyringDoc()).map((e) => e.documentId),
      ).toEqual(["d1"]);
      // Never in clear: no link in what IndexedDB holds, but the keyring's
      // own in the page's records, and not even that sealed (M2).
      const raw = JSON.stringify(
        (await rawValues(idb)).map((v) =>
          ArrayBuffer.isView(v) ? Buffer.from(v.buffer).toString("latin1") : v,
        ),
      );
      expect(raw).not.toContain("doc=d1");
      expect(raw.includes(formatKeyringLink(mine))).toBe(!sealKey);
    });

    test("two tabs saving at once both end in the copy", async () => {
      const idb = new IDBFactory();
      const lock = memoryLock();
      const mine = credentials();
      await openLocal({ indexedDB: idb, lock }).replace(mine, newKeyringDoc());
      const a = newKeyringDoc();
      const b = newKeyringDoc();
      rememberLink(a, link("d1"), { at: 1 });
      rememberLink(b, link("d22"), { at: 1 });
      const [ra, rb] = await Promise.all([
        openLocal({ indexedDB: idb, lock }).save(mine, a),
        openLocal({ indexedDB: idb, lock }).save(mine, b),
      ]);
      expect([ra, rb]).toEqual(["saved", "saved"]);
      const loaded = await openLocal({ indexedDB: idb, lock }).load();
      expect(
        listKeyring(loaded?.doc ?? newKeyringDoc()).map((e) => e.documentId),
      ).toEqual(["d1", "d22"]);
      // The second saver merged the first's into its own document.
      expect(
        listKeyring(b).length + listKeyring(a).length,
      ).toBeGreaterThanOrEqual(3);
    });

    test("a save over another keyring writes nothing: it was superseded", async () => {
      const idb = new IDBFactory();
      const lock = memoryLock();
      const old = credentials("aa".repeat(16));
      const now = credentials("bb".repeat(16));
      await openLocal({ indexedDB: idb, lock }).replace(now, newKeyringDoc());
      const doc = newKeyringDoc();
      rememberLink(doc, link("d1"), { at: 1 });
      expect(await openLocal({ indexedDB: idb, lock }).save(old, doc)).toBe(
        "superseded",
      );
      const loaded = await openLocal({ indexedDB: idb, lock }).load();
      expect(loaded?.ref.keyringId).toBe(now.keyringId);
      expect(listKeyring(loaded?.doc ?? newKeyringDoc())).toEqual([]);
    });

    test("forgotten: nothing loaded", async () => {
      const idb = new IDBFactory();
      const local = openLocal({ indexedDB: idb, lock: memoryLock() });
      const mine = credentials();
      await local.replace(mine, newKeyringDoc());
      await local.forget(mine);
      expect(await local.load()).toBeUndefined();
    });

    // Security review of 18d: a key mistyped in one tab never erases a
    // keyring another tab just put here — its key may exist nowhere else.
    test("a claim never writes over another keyring, nor a forget erases one", async () => {
      const idb = new IDBFactory();
      const lock = memoryLock();
      const theirs = credentials("aa".repeat(16));
      const mine = credentials("bb".repeat(16));
      expect(
        await openLocal({ indexedDB: idb, lock }).claim(
          theirs,
          newKeyringDoc(),
        ),
      ).toBe("claimed");
      expect(
        await openLocal({ indexedDB: idb, lock }).claim(mine, newKeyringDoc()),
      ).toBe("taken");
      await openLocal({ indexedDB: idb, lock }).forget(mine);
      const loaded = await openLocal({ indexedDB: idb, lock }).load();
      expect(loaded?.ref.keyringId).toBe(theirs.keyringId);
      // The same keyring claimed again: fine.
      expect(
        await openLocal({ indexedDB: idb, lock }).claim(
          theirs,
          newKeyringDoc(),
        ),
      ).toBe("claimed");
    });

    // Analysis 18f, cases 5 and 6: a keyring handed over by another device
    // joins what this device holds, under the lock — never erases it.
    test("joining a keyring merges the copy stored here, another list only when told", async () => {
      const idb = new IDBFactory();
      const lock = memoryLock();
      const local = openLocal({ indexedDB: idb, lock });
      const given = credentials("cc".repeat(16));
      // Nothing here: the keyring given, as it comes.
      const first = newKeyringDoc();
      rememberLink(first, link("d1"), { at: 1 });
      expect(await local.join(given, first)).toBe("nothing-here");
      // Another keyring here, with its own document.
      const idb2 = new IDBFactory();
      const other = openLocal({ indexedDB: idb2, lock: memoryLock() });
      const mine = newKeyringDoc();
      rememberLink(mine, link("d22"), { at: 1 });
      await other.replace(credentials("dd".repeat(16)), mine);
      const joined = newKeyringDoc();
      rememberLink(joined, link("d1"), { at: 2 });
      // Unless told to merge, another list stays as it was (security
      // review of 18f): nothing written.
      expect(await other.join(given, joined)).toBe("other");
      expect((await other.load())?.ref.keyringId).toBe("dd".repeat(16));
      expect(listKeyring(joined).map((e) => e.documentId)).toEqual(["d1"]);
      expect(await other.join(given, joined, { merge: true })).toBe("merged");
      const loaded = await openLocal({
        indexedDB: idb2,
        lock: memoryLock(),
      }).load();
      expect(loaded?.ref.keyringId).toBe(given.keyringId);
      expect(
        listKeyring(loaded?.doc ?? newKeyringDoc())
          .map((e) => e.documentId)
          .sort(),
      ).toEqual(["d1", "d22"]);
      // The doc passed holds it all too, for the session that follows.
      expect(
        listKeyring(joined)
          .map((e) => e.documentId)
          .sort(),
      ).toEqual(["d1", "d22"]);
      // The same keyring again: its copy merged, nothing else to say.
      expect(await other.join(given, newKeyringDoc())).toBe("same");
    });
  });

  describe("the account signed in on this device (decision 5, analysis 18i.2)", () => {
    const signedIn = (token: string) => ({
      gateway: "https://accounts.example",
      token,
      deadline: 1_800_000_000_000,
      name: "Ada",
      email: null,
      issuer: "https://idp.example",
      sub: "u-1",
    });

    test("kept, read back, and forgotten only by its own token", async () => {
      const idb = new IDBFactory();
      const local = openLocal({ indexedDB: idb, lock: memoryLock() });
      expect(await local.signedIn()).toBeUndefined();
      await local.keepSignedIn(signedIn("T1"));
      expect(await local.signedIn()).toEqual(signedIn("T1"));
      // Another tab signed in meanwhile: its token stays (SI3).
      await local.keepSignedIn(signedIn("T2"));
      await local.forgetSignedIn("T1");
      expect(await local.signedIn()).toEqual(signedIn("T2"));
      await local.forgetSignedIn("T2");
      expect(await local.signedIn()).toBeUndefined();
    });

    test("the list and the account are forgotten apart", async () => {
      const idb = new IDBFactory();
      const local = openLocal({ indexedDB: idb, lock: memoryLock() });
      const mine = credentials();
      await local.replace(mine, newKeyringDoc());
      await local.keepSignedIn(signedIn("T1"));
      await local.forget(mine);
      expect(await local.load()).toBeUndefined();
      expect(await local.signedIn()).toEqual(signedIn("T1"));
      await local.replace(mine, newKeyringDoc());
      await local.forgetSignedIn("T1");
      expect((await local.load())?.ref.keyringId).toBe(mine.keyringId);
    });

    test("a record of another form is no account", async () => {
      for (const record of [
        "text",
        null,
        { ...signedIn("T1"), deadline: "soon" },
        { ...signedIn("T1"), email: 3 },
        { ...signedIn("T1"), sub: undefined },
      ]) {
        const idb = new IDBFactory();
        const local = openLocal({ indexedDB: idb, lock: memoryLock() });
        await local.keepSignedIn(signedIn("T1"));
        const db = await new Promise<IDBDatabase>((resolve) => {
          const request = idb.open("oc:keyring");
          request.onsuccess = () => resolve(request.result);
        });
        await new Promise<void>((resolve) => {
          const transaction = db.transaction("keyring", "readwrite");
          transaction.objectStore("keyring").put(record, "account");
          transaction.oncomplete = () => resolve();
        });
        expect(await local.signedIn(), JSON.stringify(record)).toBeUndefined();
      }
    });
  });

  describe("a recent sign-in and an attestation (analysis 18k)", () => {
    const signedIn = {
      gateway: "https://accounts.example",
      token: "T1",
      deadline: 1_800_000_000_000,
      recentUntil: 1_700_000_600_000,
      name: "Ada",
      email: null,
      issuer: "https://idp.example",
      sub: "u-1",
    };
    const kept = {
      gateway: "https://accounts.example",
      issuer: "https://idp.example",
      sub: "u-1",
      envelope: new Uint8Array([0xa3, 1, 2]),
    };

    test("a recent sign-in keeps its end; one of another type is none", async () => {
      const idb = new IDBFactory();
      const local = openLocal({ indexedDB: idb, lock: memoryLock() });
      await local.keepSignedIn(signedIn);
      expect(await local.signedIn()).toEqual(signedIn);
      await local.keepSignedIn({ ...signedIn, recentUntil: "soon" as never });
      expect(await local.signedIn()).toBeUndefined();
    });

    test("the attestation outlives the token, and is replaced whole", async () => {
      const idb = new IDBFactory();
      const local = openLocal({ indexedDB: idb, lock: memoryLock() });
      expect(await local.attestation()).toBeUndefined();
      await local.keepSignedIn(signedIn);
      await local.keepAttestation(kept);
      await local.forgetSignedIn("T1");
      const read = await local.attestation();
      expect(read && { ...read, envelope: [...read.envelope] }).toEqual({
        ...kept,
        envelope: [0xa3, 1, 2],
      });
      await local.keepAttestation({ ...kept, sub: "u-2" });
      expect((await local.attestation())?.sub).toBe("u-2");
      await local.keepAttestation({ ...kept, envelope: 7 as never });
      expect(await local.attestation()).toBeUndefined();
    });

    // Phase 30, NK1: beside the attestation, replaced by the next.
    test("a refused key outlives the token, replaced whole; one of another form is none", async () => {
      const idb = new IDBFactory();
      const local = openLocal({ indexedDB: idb, lock: memoryLock() });
      expect(await local.refusedKey()).toBeUndefined();
      const refused = {
        gateway: kept.gateway,
        issuer: kept.issuer,
        sub: kept.sub,
        key: new Uint8Array(32).fill(7),
      };
      await local.keepSignedIn(signedIn);
      await local.keepRefusedKey(refused);
      await local.forgetSignedIn("T1");
      const read = await local.refusedKey();
      expect(read && { ...read, key: [...read.key] }).toEqual({
        ...refused,
        key: [...refused.key],
      });
      // The attestation is another record.
      expect(await local.attestation()).toBeUndefined();
      await local.keepRefusedKey({ ...refused, sub: "u-2" });
      expect((await local.refusedKey())?.sub).toBe("u-2");
      await local.keepRefusedKey({ ...refused, key: new Uint8Array(31) });
      expect(await local.refusedKey()).toBeUndefined();
    });
  });

  describe("an account's list (analysis 18i.3)", () => {
    const account = (sub: string, fill: number) => ({
      gateway: "https://accounts.example",
      issuer: "https://idp.example",
      sub,
      key: new Uint8Array(32).fill(fill),
    });

    test("TR7: never joins another account's keyring, even when told to merge", async () => {
      const local = openLocal({
        indexedDB: new IDBFactory(),
        lock: memoryLock(),
      });
      const mine = newKeyringDoc();
      rememberLink(mine, link("d1"), { at: 1 });
      await local.replace(account("u-1", 1), mine);
      expect(
        await local.join(account("u-2", 2), newKeyringDoc(), { merge: true }),
      ).toBe("other");
      expect((await local.load())?.ref).toMatchObject({ sub: "u-1" });
      // The same account, under the key another device holds: merged.
      expect(
        await local.join(account("u-1", 3), newKeyringDoc(), { merge: true }),
      ).toBe("merged");
    });
  });

  describe("the association between two tabs (analysis 18p, RA1, RA2)", () => {
    const account = {
      gateway: "https://accounts.example",
      issuer: "https://idp.example",
      sub: "u-1",
      key: new Uint8Array(32).fill(7),
    };

    test("RA1: an automatic association writes nothing over a list holding documents", async () => {
      const local = openLocal({
        indexedDB: new IDBFactory(),
        lock: memoryLock(),
      });
      const mine = credentials();
      const stored = newKeyringDoc();
      rememberLink(stored, link("d1"), { at: 1 });
      await local.replace(mine, stored);
      // The tab's own view is empty: the copy stored is what decides.
      expect(
        await local.rotate(account, newKeyringDoc(), mine, {
          onlyIfEmpty: true,
        }),
      ).toBe("not-empty");
      expect((await local.load())?.ref).toEqual(mine);
      expect(await local.retired()).toEqual([]);
      // Empty, it is associated.
      await local.replace(mine, newKeyringDoc());
      expect(
        await local.rotate(account, newKeyringDoc(), mine, {
          onlyIfEmpty: true,
        }),
      ).toBe("rotated");
    });

    // Found by the association's property (« Défauts connus », 2026-10-23):
    // a document the tab added after its judgment, its write still waiting
    // for the lock, refused the association; the tab then judged the copy
    // again, empty, and stayed on its list while the other tab associated.
    test("RA1: the tab's own document, not yet in the copy, is associated with the list", async () => {
      const local = openLocal({
        indexedDB: new IDBFactory(),
        lock: memoryLock(),
      });
      const mine = credentials();
      await local.replace(mine, newKeyringDoc());
      const view = newKeyringDoc();
      rememberLink(view, link("d2"), { at: 2 });
      expect(
        await local.rotate(account, view, mine, { onlyIfEmpty: true }),
      ).toBe("rotated");
      const after = await local.load();
      expect(after?.ref).toEqual(account);
      const entries = after?.doc ? listKeyring(after.doc) : [];
      expect(entries.map((e) => e.documentId)).toEqual(["d2"]);
    });

    test("RA2: a list replaced on this device leads to the one that replaced it; another one, never", async () => {
      const local = openLocal({
        indexedDB: new IDBFactory(),
        lock: memoryLock(),
      });
      const mine = credentials();
      await local.replace(mine, newKeyringDoc());
      expect(await local.successor(mine)).toBeUndefined();
      const doc = newKeyringDoc();
      rememberLink(doc, link("d1"), { at: 1 });
      await local.rotate(account, doc, mine);
      const next = await local.successor(mine);
      expect(next?.ref).toEqual(account);
      expect(
        listKeyring(next?.doc ?? newKeyringDoc()).map((e) => e.documentId),
      ).toEqual(["d1"]);
      // Still after the old one is deleted (its note cleared).
      await local.clearRetired(mine);
      expect((await local.successor(mine))?.ref).toEqual(account);
      // A list of another lineage (a key pasted, KR-37) is not followed.
      const other = credentials("cd".repeat(16));
      const pasted = openLocal({
        indexedDB: new IDBFactory(),
        lock: memoryLock(),
      });
      await pasted.replace(mine, newKeyringDoc());
      await pasted.replace(other, newKeyringDoc());
      expect(await pasted.successor(mine)).toBeUndefined();
      // Nor an account's list, which has no successor here.
      expect(await local.successor(account)).toBeUndefined();
    });

    test("RA2: a list put here after a change of key is never reached from the old one", async () => {
      const local = openLocal({
        indexedDB: new IDBFactory(),
        lock: memoryLock(),
      });
      const first = credentials("aa".repeat(16));
      const second = credentials("bb".repeat(16));
      const pasted = credentials("cc".repeat(16));
      await local.replace(first, newKeyringDoc());
      await local.rotate(second, newKeyringDoc(), first);
      expect((await local.successor(first))?.ref).toEqual(second);
      // Another list, of another lineage (a key pasted), in its place.
      await local.replace(pasted, newKeyringDoc());
      expect(await local.successor(first)).toBeUndefined();
      expect(await local.successor(second)).toBeUndefined();
      // Changed twice: the chain is followed to the list stored.
      const third = credentials("dd".repeat(16));
      await local.rotate(third, newKeyringDoc(), pasted);
      const fourth = credentials("ee".repeat(16));
      await local.rotate(fourth, newKeyringDoc(), third);
      expect((await local.successor(pasted))?.ref).toEqual(fourth);
    });
  });
  describe("starting over the identity's list (analysis 18p.3, RL2, RL3)", () => {
    const account = (fill: number) => ({
      gateway: "https://accounts.example",
      issuer: "https://idp.example",
      sub: "u-1",
      key: new Uint8Array(32).fill(fill),
    });

    test("RL2: the tab's list replaced in one write, its copy merged, the new list noted", async () => {
      const local = openLocal({
        indexedDB: new IDBFactory(),
        lock: memoryLock(),
      });
      const waiting = credentials();
      const stored = newKeyringDoc();
      rememberLink(stored, link("d1"), { at: 1 });
      await local.replace(waiting, stored);
      const next = account(1);
      // The tab's view is behind: the copy stored is merged in.
      expect(await local.startOver(next, newKeyringDoc(), waiting)).toBe(
        "started",
      );
      const loaded = await local.load();
      expect(loaded?.ref).toEqual(next);
      expect(
        listKeyring(loaded?.doc ?? newKeyringDoc()).map((e) => e.documentId),
      ).toEqual(["d1"]);
      expect(await local.startingOver(next)).toBe(true);
      expect(await local.startingOver(account(2))).toBe(false);
      // The waiting list goes (KR-29), and its tabs follow (RA2).
      expect(await local.retired()).toEqual([waiting]);
      expect((await local.successor(waiting))?.ref).toEqual(next);
      // Saved again, still noted; cleared, no longer.
      expect(await local.save(next, newKeyringDoc())).toBe("saved");
      expect(await local.startingOver(next)).toBe(true);
      await local.clearStartOver(next);
      expect(await local.startingOver(next)).toBe(false);
    });

    test("RL2: with no list here, or the identity's old copy, started; another list put here, nothing written", async () => {
      const local = openLocal({
        indexedDB: new IDBFactory(),
        lock: memoryLock(),
      });
      expect(await local.startOver(account(1), newKeyringDoc())).toBe(
        "started",
      );
      // An old device: the identity's list under the old key.
      const old = account(1);
      const next = account(2);
      expect(await local.startOver(next, newKeyringDoc(), old)).toBe("started");
      expect((await local.load())?.ref).toEqual(next);
      expect(await local.retired()).toEqual([]);
      // Another tab pasted a key meanwhile: taken, nothing written.
      const pasted = credentials("cd".repeat(16));
      await local.replace(pasted, newKeyringDoc());
      expect(await local.startOver(account(3), newKeyringDoc(), next)).toBe(
        "taken",
      );
      expect((await local.load())?.ref).toEqual(pasted);
      expect(await local.startingOver(account(3))).toBe(false);
    });

    test("RL3: a list put here after drops the note, and so does forgetting it", async () => {
      const local = openLocal({
        indexedDB: new IDBFactory(),
        lock: memoryLock(),
      });
      const next = account(1);
      await local.startOver(next, newKeyringDoc());
      await local.replace(credentials(), newKeyringDoc());
      expect(await local.startingOver(next)).toBe(false);
      await local.startOver(next, newKeyringDoc());
      await local.forget(next);
      expect(await local.startingOver(next)).toBe(false);
    });
  });
});

describe("sealed by a key of the device (analysis 18m, M2, OB2)", () => {
  const signedIn = {
    gateway: "https://accounts.example",
    token: "T-secret-token",
    deadline: 1_800_000_000_000,
    name: "Ada",
    email: null,
    issuer: "https://idp.example",
    sub: "u-1",
  };
  const kept = {
    gateway: "https://accounts.example",
    issuer: "https://idp.example",
    sub: "u-1",
    envelope: new Uint8Array([0xa3, 1, 2]),
  };

  /** Every text the database holds, however deep. */
  const texts = (value: unknown): string[] => {
    if (typeof value === "string") return [value];
    if (ArrayBuffer.isView(value)) {
      return [
        new TextDecoder().decode(
          new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
        ),
      ];
    }
    if (Array.isArray(value)) return value.flatMap(texts);
    if (typeof value === "object" && value !== null) {
      return Object.values(value).flatMap(texts);
    }
    return [];
  };

  test("the keyring's link, its old links and the token are never in clear", async () => {
    const idb = new IDBFactory();
    const local = openKeyringLocal({
      indexedDB: idb,
      lock: memoryLock(),
      sealKey: SEAL,
    });
    const old = credentials();
    const next = credentials("cd".repeat(16));
    const doc = newKeyringDoc();
    rememberLink(doc, link("doc-1"), { at: 1 });
    await local.replace(old, doc);
    await local.rotate(next, doc, old);
    // A list started over: its note holds its key too (RL2).
    const started = {
      gateway: "https://accounts.example",
      issuer: "https://idp.example",
      sub: "u-1",
      key: new Uint8Array(32).fill(0x3c),
    };
    await local.startOver(started, doc, next);
    expect(await local.startingOver(started)).toBe(true);
    await local.replace(next, doc);
    await local.keepSignedIn(signedIn);
    await local.keepAttestation(kept);
    const all = texts(await rawValues(idb)).join("\n");
    for (const secret of [
      formatKeyringLink(old),
      formatKeyringLink(next),
      bytesToBase64Url(next.key),
      bytesToBase64Url(started.key),
      bytesToBase64Url(old.secret),
      signedIn.token,
      "doc-1",
    ]) {
      expect(all).not.toContain(secret);
    }
    // Read back whole.
    expect((await local.load())?.ref).toEqual(next);
    expect(await local.retired()).toEqual([old, next]);
    expect(await local.signedIn()).toEqual(signedIn);
    expect(await local.attestation()).toEqual(kept);
  });

  test("under another key, nothing reads: no keyring, no account", async () => {
    const idb = new IDBFactory();
    const lock = memoryLock();
    const mine = credentials();
    const local = openKeyringLocal({ indexedDB: idb, lock, sealKey: SEAL });
    await local.replace(mine, newKeyringDoc());
    await local.keepSignedIn(signedIn);
    for (const other of [
      openKeyringLocal({
        indexedDB: idb,
        lock,
        sealKey: new Uint8Array(32).fill(1),
      }),
      openKeyringLocal({ indexedDB: idb, lock }),
    ]) {
      expect(await other.load()).toBeUndefined();
      expect(await other.signedIn()).toBeUndefined();
    }
  });

  test("a record kept in clear is none, once sealed", async () => {
    const idb = new IDBFactory();
    const lock = memoryLock();
    const page = openKeyringLocal({ indexedDB: idb, lock });
    await page.replace(credentials(), newKeyringDoc());
    await page.keepSignedIn(signedIn);
    const sealed = openKeyringLocal({ indexedDB: idb, lock, sealKey: SEAL });
    expect(await sealed.load()).toBeUndefined();
    expect(await sealed.signedIn()).toBeUndefined();
  });
});
