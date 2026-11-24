// @vitest-environment jsdom
//
// A keyring session whose copy on the device can't be written while it
// synchronises (IndexedDB refusing a write; in the scenario, a tab
// reloaded): the synchronisation says so, and the next one runs — found by
// the scenario of phase 18f, where `sync()` rejected unhandled and the
// session never synchronised again.
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, test } from "vitest";
import {
  createKeyring,
  decryptKeyring,
  encryptKeyring,
  listKeyring,
  newKeyringDoc,
  newKeyringSecrets,
  readKeyringPlaintext,
  rememberLink,
} from "../../lib/src/index.js";
import { FakeKeyringServer } from "../../lib/src/keyring/test-support/fake-keyring-server.js";
import { testLink } from "../../lib/src/keyring/test-support/links.js";
import { FakeGateway } from "../account/test-support.js";
import { sessionOptions } from "./environment.js";
import { type KeyringLocal, openKeyringLocal } from "./local.js";
import { KeyringSession } from "./session.js";

const ORIGIN = "https://collab.test";

const lock = {
  exclusive: <T>(_name: string, run: () => Promise<T>) => run(),
};

describe("a keyring session", () => {
  test("a copy that can't be written during a sync: said, and the next sync runs", async () => {
    const server = new FakeKeyringServer();
    const created = await createKeyring(ORIGIN, server.fetch);
    // Another device put a document in the keyring: this one's sync
    // brings it, then writes its copy.
    const other = await KeyringSession.adopt(
      sessionOptions(
        {
          local: openKeyringLocal({ indexedDB: new IDBFactory(), lock }),
          fetch: server.fetch,
          setTimer: () => () => {},
        },
        ORIGIN,
      ),
      created,
    );
    await other?.change(
      (doc) => void rememberLink(doc, testLink("d1", "edit", 0), { at: 1 }),
    );
    expect(await other?.sync()).toBe("synced");

    const real = openKeyringLocal({ indexedDB: new IDBFactory(), lock });
    let failing = true;
    const local: KeyringLocal = {
      ...real,
      save: (credentials, doc) =>
        failing
          ? Promise.reject(new Error("the device's storage refused"))
          : real.save(credentials, doc),
    };
    const statuses: string[] = [];
    const session = await KeyringSession.adopt(
      {
        ...sessionOptions(
          { local, fetch: server.fetch, setTimer: () => () => {} },
          ORIGIN,
        ),
        onStatus: (status) => statuses.push(status),
      },
      created,
    );
    if (!session) throw new Error("not adopted");
    expect(await session.sync()).toBe("unsaved");
    expect(statuses).toEqual(["unsaved"]);
    failing = false;
    expect(await session.sync()).toBe("synced");
    expect(listKeyring(session.doc).map((e) => e.documentId)).toEqual(["d1"]);
    const stored = await real.load();
    expect(
      listKeyring(stored?.doc ?? session.doc).map((e) => e.documentId),
    ).toEqual(["d1"]);
  });

  // Found by the flakiness of the pairing test (18f): a sync asked while
  // the previous one deletes the old keyrings (KR-29) got that one's
  // promise, and its write was never sent.
  test("a sync asked while old keyrings are being deleted sends what it was asked for", async () => {
    const server = new FakeKeyringServer();
    const created = await createKeyring(ORIGIN, server.fetch);
    const real = openKeyringLocal({ indexedDB: new IDBFactory(), lock });
    let reached = () => {};
    const reading = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const local: KeyringLocal = {
      ...real,
      retired: async () => {
        reached();
        await held;
        return [];
      },
    };
    const session = await KeyringSession.adopt(
      sessionOptions(
        { local, fetch: server.fetch, setTimer: () => () => {} },
        ORIGIN,
      ),
      created,
    );
    if (!session) throw new Error("not adopted");
    const first = session.sync();
    await reading;
    await session.change(
      (doc) => void rememberLink(doc, testLink("d2", "edit", 0), { at: 2 }),
    );
    const second = session.sync();
    release();
    expect(await second).toBe("synced");
    await first;
    const kept = server.keyrings.get(created.keyringId);
    const stored = readKeyringPlaintext(
      await decryptKeyring(created.key, kept?.blob ?? new Uint8Array()),
    );
    expect(listKeyring(stored ?? session.doc).map((e) => e.documentId)).toEqual(
      ["d2"],
    );
  });

  // Found by the scenario of 18p.3: a tab left on the list another tab
  // replaced (RA2 followed only at its next write) synced it, found the
  // old keyring to delete was its own, and cleared the note without
  // deleting it: the old keyring stayed on the server for good (KR-29).
  test("a tab left on a list replaced here neither deletes nor forgets the old keyring", async () => {
    const server = new FakeKeyringServer();
    const local = openKeyringLocal({ indexedDB: new IDBFactory(), lock });
    const options = sessionOptions(
      { local, fetch: server.fetch, setTimer: () => () => {} },
      ORIGIN,
    );
    const old = await createKeyring(ORIGIN, server.fetch);
    const left = await KeyringSession.adopt(options, old);
    const other = await KeyringSession.open(options);
    if (!left || !other) throw new Error("not opened");
    const next = await createKeyring(ORIGIN, server.fetch);
    const rotated = await KeyringSession.rotate(other, next);
    expect(await left.sync()).toBe("synced");
    expect((await local.retired()).map((r) => r.keyringId)).toEqual([
      old.keyringId,
    ]);
    expect(server.keyrings.has(old.keyringId)).toBe(true);
    // The device's list deletes it.
    expect(await rotated?.sync()).toBe("synced");
    expect(server.keyrings.has(old.keyringId)).toBe(false);
    expect(await local.retired()).toEqual([]);
  });

  // Analysis 18p, RA3: a tab judges on the list that replaced its own
  // here, followed without writing; never on a list of another lineage.
  test("RA3: a tab left on a list replaced here follows it, without writing; another list put here, not", async () => {
    const server = new FakeKeyringServer();
    const local = openKeyringLocal({ indexedDB: new IDBFactory(), lock });
    const options = sessionOptions(
      { local, fetch: server.fetch, setTimer: () => () => {} },
      ORIGIN,
    );
    const old = await createKeyring(ORIGIN, server.fetch);
    const left = await KeyringSession.adopt(options, old);
    const other = await KeyringSession.open(options);
    if (!left || !other) throw new Error("not opened");
    expect(await left.follow()).toBe(false);
    const next = await createKeyring(ORIGIN, server.fetch);
    const rotated = await KeyringSession.rotate(other, next);
    await rotated?.change(
      (d) => void rememberLink(d, testLink("d1", "edit"), { at: 1 }),
    );
    expect(await left.follow()).toBe(true);
    expect(left.ref.keyringId).toBe(next.keyringId);
    expect(left.ref.key).toEqual(next.key);
    expect(left.entries().map((e) => e.documentId)).toEqual(["d1"]);
    expect(await left.follow()).toBe(false);

    // A list pasted here, of another lineage: not followed.
    const pasted = await createKeyring(ORIGIN, server.fetch);
    await local.replace(pasted, newKeyringDoc());
    expect(await left.follow()).toBe(false);
    expect(left.ref.keyringId).toBe(next.keyringId);
  });

  // RA3 with RA2: a write waits for the lock while its tab follows the
  // list that replaced its own (a judgment); refused under the old list,
  // it is written under the one followed, not lost as « superseded ».
  test("RA3: a write waiting for the lock while its tab follows: written under the list followed", async () => {
    const server = new FakeKeyringServer();
    let gate: Promise<void> = Promise.resolve();
    const local = openKeyringLocal({
      indexedDB: new IDBFactory(),
      lock: {
        exclusive: async (_name, run) => {
          await gate;
          return run();
        },
      },
    });
    const options = sessionOptions(
      { local, fetch: server.fetch, setTimer: () => () => {} },
      ORIGIN,
    );
    const old = await createKeyring(ORIGIN, server.fetch);
    const left = await KeyringSession.adopt(options, old);
    const other = await KeyringSession.open(options);
    if (!left || !other) throw new Error("not opened");
    const next = await createKeyring(ORIGIN, server.fetch);
    await KeyringSession.rotate(other, next);
    let open = () => {};
    gate = new Promise((resolve) => {
      open = resolve;
    });
    const written = left.change(
      (d) => void rememberLink(d, testLink("d2", "edit"), { at: 2 }),
    );
    expect(await left.follow()).toBe(true);
    open();
    expect(await written).toBe("saved");
    const stored = await local.load();
    expect(stored?.ref.keyringId).toBe(next.keyringId);
    expect(
      listKeyring(stored?.doc ?? newKeyringDoc()).map((e) => e.documentId),
    ).toEqual(["d2"]);
  });

  // Analysis 18r, UK1: an edit decided under the lock, on the copy stored
  // by every holder of the list here — the other's write seen first.
  test("UK1: changeStored sees what another session of the list wrote here", async () => {
    const server = new FakeKeyringServer();
    const local = openKeyringLocal({ indexedDB: new IDBFactory(), lock });
    const options = sessionOptions(
      { local, fetch: server.fetch, setTimer: () => () => {} },
      ORIGIN,
    );
    const first = await KeyringSession.adopt(
      options,
      await createKeyring(ORIGIN, server.fetch),
    );
    const second = await KeyringSession.open(options);
    if (!first || !second) throw new Error("not opened");
    await first.change(
      (d) => void rememberLink(d, testLink("d1", "edit"), { at: 1 }),
    );
    let seen: string[] = [];
    expect(
      await second.changeStored((d) => {
        seen = listKeyring(d).map((e) => e.documentId);
        rememberLink(d, testLink("d2", "edit"), { at: 2 });
      }),
    ).toBe("saved");
    expect(seen).toEqual(["d1"]);
    const stored = await local.load();
    expect(
      listKeyring(stored?.doc ?? newKeyringDoc())
        .map((e) => e.documentId)
        .sort(),
    ).toEqual(["d1", "d2"]);
  });

  test("UK1: changeStored on a list replaced here: applied on the list followed, after its copy", async () => {
    const server = new FakeKeyringServer();
    const local = openKeyringLocal({ indexedDB: new IDBFactory(), lock });
    const options = sessionOptions(
      { local, fetch: server.fetch, setTimer: () => () => {} },
      ORIGIN,
    );
    const left = await KeyringSession.adopt(
      options,
      await createKeyring(ORIGIN, server.fetch),
    );
    const other = await KeyringSession.open(options);
    if (!left || !other) throw new Error("not opened");
    const next = await createKeyring(ORIGIN, server.fetch);
    const rotated = await KeyringSession.rotate(other, next);
    await rotated?.change(
      (d) => void rememberLink(d, testLink("d1", "edit"), { at: 1 }),
    );
    const seen: string[][] = [];
    expect(
      await left.changeStored((d) => {
        seen.push(listKeyring(d).map((e) => e.documentId));
      }),
    ).toBe("saved");
    // Applied once, under the list followed, its copy merged in.
    expect(seen).toEqual([["d1"]]);
    expect(left.ref.keyringId).toBe(next.keyringId);
  });

  describe("starting over the identity's list (analysis 18p.3, RL2, RL3)", () => {
    /** A device signed in as `u-1`, its keyring session's options. */
    async function signedInDevice(gateway: FakeGateway) {
      const local = openKeyringLocal({ indexedDB: new IDBFactory(), lock });
      await local.keepSignedIn({
        gateway: gateway.origin,
        token: gateway.tokenOf("u-1"),
        deadline: Date.now() + 3_600_000,
        name: "u-1",
        email: null,
        issuer: "https://idp.example",
        sub: "u-1",
      });
      const options = sessionOptions(
        {
          local,
          fetch: (url, init) => gateway.fetch(url, init),
          setTimer: () => () => {},
          account: {
            local,
            openWindow: () => {},
            channel: () => ({ post: () => {}, listen: () => () => {} }),
          },
        },
        ORIGIN,
      );
      return { local, options };
    }
    const identity = (gateway: FakeGateway, key: Uint8Array) => ({
      gateway: gateway.origin,
      issuer: "https://idp.example",
      sub: "u-1",
      key,
    });
    /** The identity's list, kept under a key this device doesn't have. */
    async function lostList(gateway: FakeGateway) {
      const lost = newKeyringDoc();
      rememberLink(lost, testLink("lost", "edit", 0), { at: 1 });
      gateway.keyrings.set("u-1", {
        version: 4,
        blob: await encryptKeyring(
          newKeyringSecrets().key,
          lost.export({ mode: "snapshot" }),
        ),
      });
    }
    const listed = async (gateway: FakeGateway, key: Uint8Array) =>
      listKeyring(
        readKeyringPlaintext(
          await decryptKeyring(key, gateway.keyringOf("u-1").blob),
        ) ?? newKeyringDoc(),
      ).map((e) => e.documentId);

    test("the list started over is written over the one that doesn't read, once, and the note goes", async () => {
      const gateway = new FakeGateway();
      await lostList(gateway);
      const { local, options } = await signedInDevice(gateway);
      const doc = newKeyringDoc();
      rememberLink(doc, testLink("mine", "edit", 0), { at: 2 });
      const next = identity(gateway, newKeyringSecrets().key);
      const session = await KeyringSession.startOver(options, next, doc);
      if (!session) throw new Error("not started");
      expect(await session.sync()).toBe("synced");
      expect(await listed(gateway, next.key)).toEqual(["mine"]);
      expect(await local.startingOver(next)).toBe(false);
      // Once synced, the list is as any other: another start over
      // elsewhere makes it unreadable here, never written over again.
      await lostList(gateway);
      const version = gateway.keyringOf("u-1").version;
      expect(await session.sync()).toBe("unreadable");
      expect(gateway.keyringOf("u-1").version).toBe(version);
    });

    test("a list of the identity not started over never writes over one that doesn't read (KR-19)", async () => {
      const gateway = new FakeGateway();
      await lostList(gateway);
      const { options } = await signedInDevice(gateway);
      const next = identity(gateway, newKeyringSecrets().key);
      const session = await KeyringSession.adopt(options, next);
      expect(await session?.sync()).toBe("unreadable");
      expect(gateway.keyringOf("u-1").version).toBe(4);
    });

    test("the page reloaded before the write: the next session writes over", async () => {
      const gateway = new FakeGateway();
      await lostList(gateway);
      const { options } = await signedInDevice(gateway);
      const next = identity(gateway, newKeyringSecrets().key);
      const first = await KeyringSession.startOver(
        options,
        next,
        newKeyringDoc(),
      );
      first?.close();
      const again = await KeyringSession.open(options);
      expect(await again?.sync()).toBe("synced");
      expect(await listed(gateway, next.key)).toEqual([]);
    });

    test("case 8: the note left after the write, the next sync, which reads its own list, clears it", async () => {
      const gateway = new FakeGateway();
      await lostList(gateway);
      const { local, options } = await signedInDevice(gateway);
      const next = identity(gateway, newKeyringSecrets().key);
      const first = await KeyringSession.startOver(options, next);
      // Written over, the note not cleared (the page closed then).
      const clear = local.clearStartOver;
      local.clearStartOver = async () => {};
      expect(await first?.sync()).toBe("synced");
      first?.close();
      local.clearStartOver = clear;
      expect(await local.startingOver(next)).toBe(true);
      const again = await KeyringSession.open(options);
      expect(await again?.sync()).toBe("synced");
      expect(await local.startingOver(next)).toBe(false);
    });

    // Found by the scenario of 18p.3: a tab syncing the list in waiting
    // followed the list started over meanwhile (RA2), and, its sync of
    // the old list done, cleared the new one's note: never written over.
    test("a sync of the list in waiting, its tab following the list started over meanwhile, leaves the note", async () => {
      const server = new FakeKeyringServer();
      const gateway = new FakeGateway();
      await lostList(gateway);
      const { local, options: accountOptions } = await signedInDevice(gateway);
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const options = sessionOptions(
        {
          local,
          fetch: async (url, init) => {
            if (new URL(url).origin === gateway.origin)
              return gateway.fetch(url, init);
            if ((init?.method ?? "GET") === "GET") await held;
            return server.fetch(url, init);
          },
          setTimer: () => () => {},
          account: accountOptions && {
            local,
            openWindow: () => {},
            channel: () => ({ post: () => {}, listen: () => () => {} }),
          },
        },
        ORIGIN,
      );
      const waiting = await createKeyring(ORIGIN, server.fetch);
      const left = await KeyringSession.adopt(options, waiting);
      if (!left) throw new Error("not adopted");
      const syncing = left.sync();
      const next = identity(gateway, waiting.key);
      const started = await KeyringSession.startOver(
        options,
        next,
        newKeyringDoc(),
        waiting,
      );
      // The tab writes: its list replaced, it follows the new one.
      await left.change(
        (d) => void rememberLink(d, testLink("d1", "edit", 0), { at: 1 }),
      );
      expect(left.ref).toEqual(next);
      release();
      await syncing;
      expect(await local.startingOver(next)).toBe(true);
      expect(await started?.sync()).toBe("synced");
      expect(await left.sync()).toBe("synced");
      expect(await listed(gateway, next.key)).toEqual(["d1"]);
    });

    test("another list put here meanwhile: nothing started", async () => {
      const gateway = new FakeGateway();
      const { local, options } = await signedInDevice(gateway);
      const waiting = { keyringId: "ab".repeat(16), ...newKeyringSecrets() };
      const pasted = { keyringId: "cd".repeat(16), ...newKeyringSecrets() };
      await local.replace(pasted, newKeyringDoc());
      const next = identity(gateway, waiting.key);
      expect(
        await KeyringSession.startOver(options, next, newKeyringDoc(), waiting),
      ).toBeUndefined();
      expect((await local.load())?.ref).toEqual(pasted);
    });
  });
});
