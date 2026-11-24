import { IDBFactory } from "fake-indexeddb";
import { describe, expect, test } from "vitest";
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
import { type KeyringEnvironment, sessionOptions } from "./environment.js";
import { type KeyringLock, openKeyringLocal } from "./local.js";
// @vitest-environment jsdom
//
// Changing the key of « Mes documents » (decision 6; docs/protocol/
// 05-keyring.md, KR-29, KR-30; analysis 18e, cases 2 to 5): the new
// keyring holds the copy before the old one is deleted; a deletion that
// failed is tried again; a device that wrote into the old keyring merges
// its copy into the new one; changing the key twice at once loses nothing.
// On the keyring server in memory and fake-indexeddb.
import { linkOf, sameKeyring } from "./ref.js";
import { KeyringSession } from "./session.js";

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

/** A device whose timers never fire: the test syncs when it says. */
function device(
  server: FakeKeyringServer,
  indexedDB = new IDBFactory(),
): KeyringEnvironment {
  return {
    local: openKeyringLocal({ indexedDB, lock: memoryLock() }),
    fetch: server.fetch,
    setTimer: () => () => {},
  };
}

const options = (env: KeyringEnvironment) => sessionOptions(env, ORIGIN);

async function newSession(
  env: KeyringEnvironment,
  server: FakeKeyringServer,
  credentials?: KeyringCredentials,
) {
  const created = credentials ?? (await createKeyring(ORIGIN, server.fetch));
  const session = await KeyringSession.adopt(options(env), created);
  if (!session) throw new Error("not adopted");
  return session;
}

const write = (session: KeyringSession, doc: string, at: number) =>
  session.change(
    (d) => void rememberLink(d, testLink(doc, "edit", 0, `${ORIGIN}/`), { at }),
  );

/** A change of key that went through (no other tab in these tests). */
async function rotated(
  ...args: Parameters<typeof KeyringSession.rotate>
): Promise<KeyringSession> {
  const next = await KeyringSession.rotate(...args);
  if (!next) throw new Error("another keyring here");
  return next;
}

const ids = (session: KeyringSession) =>
  session.entries().map((e) => e.documentId);

async function stored(
  server: FakeKeyringServer,
  credentials: KeyringCredentials,
) {
  const kept = server.keyrings.get(credentials.keyringId);
  if (!kept) return undefined;
  const doc = readKeyringPlaintext(
    await decryptKeyring(credentials.key, kept.blob),
  );
  return doc ? listKeyring(doc).map((e) => e.documentId) : undefined;
}

describe("changing the key of « Mes documents »", () => {
  test("KR-29: the new keyring holds the copy, then the old one is deleted", async () => {
    const server = new FakeKeyringServer();
    const env = device(server);
    const old = await newSession(env, server);
    await write(old, "d1", 1);
    expect(await old.sync()).toBe("synced");
    const next = await rotated(old, await createKeyring(ORIGIN, server.fetch));
    // Stored before anything else: the device finds the new key.
    expect((await env.local.load())?.ref.keyringId).toBe(next.ref.keyringId);
    expect(await next.retiring()).toBe(true);
    // Not before the new keyring holds the copy.
    expect(server.keyrings.has(linkOf(old.ref).keyringId)).toBe(true);
    expect(await next.sync()).toBe("synced");
    expect(await stored(server, linkOf(next.ref))).toEqual(["d1"]);
    expect(server.keyrings.has(linkOf(old.ref).keyringId)).toBe(false);
    expect(await next.retiring()).toBe(false);
  });

  test("case 3: a deletion that failed stays noted, and is tried again after the next sync", async () => {
    const server = new FakeKeyringServer();
    const env = device(server);
    const old = await newSession(env, server);
    await old.sync();
    const created = await createKeyring(ORIGIN, server.fetch);
    const next = await rotated(old, created);
    // The new keyring written, then the network gone for the deletion.
    const flaky = {
      ...options(env),
      remove: async () => Promise.reject(new TypeError("offline")),
    };
    const offline = await KeyringSession.open(flaky);
    expect(await offline?.sync()).toBe("synced");
    expect(server.keyrings.has(linkOf(old.ref).keyringId)).toBe(true);
    expect(await next.retiring()).toBe(true);
    // Case 2 as well: the next start syncs, and deletes.
    const later = await KeyringSession.open(options(env));
    expect(await later?.sync()).toBe("synced");
    expect(server.keyrings.has(linkOf(old.ref).keyringId)).toBe(false);
    expect(await later?.retiring()).toBe(false);
  });

  test("case 4, KR-30: a device that wrote into the old keyring merges its copy into the new one", async () => {
    const server = new FakeKeyringServer();
    const a = device(server);
    const b = device(server);
    const first = await newSession(a, server);
    await first.sync();
    const other = await newSession(b, server, linkOf(first.ref));
    await other.sync();
    // B writes into the old keyring; A changes the key meanwhile.
    await write(other, "from-b", 2);
    const next = await rotated(
      first,
      await createKeyring(ORIGIN, server.fetch),
    );
    await write(next, "from-a", 3);
    expect(await other.sync()).toBe("synced");
    expect(await next.sync()).toBe("synced");
    expect(server.keyrings.has(linkOf(first.ref).keyringId)).toBe(false);
    // B finds its keyring gone, and is given the new key.
    expect(await other.sync()).toBe("missing");
    const merged = await KeyringSession.adopt(
      options(b),
      next.ref,
      other.doc,
      true,
    );
    expect(await merged?.sync()).toBe("synced");
    expect(await stored(server, linkOf(next.ref))).toEqual([
      "from-a",
      "from-b",
    ]);
    expect(await next.sync()).toBe("synced");
    expect(ids(next)).toEqual(["from-a", "from-b"]);
  });

  test("case 5: two devices changing the key at once lose nothing", async () => {
    const server = new FakeKeyringServer();
    const a = device(server);
    const b = device(server);
    const first = await newSession(a, server);
    await write(first, "d1", 1);
    await first.sync();
    const other = await newSession(b, server, linkOf(first.ref));
    await other.sync();
    const nextA = await rotated(
      first,
      await createKeyring(ORIGIN, server.fetch),
    );
    const nextB = await rotated(
      other,
      await createKeyring(ORIGIN, server.fetch),
    );
    await write(nextB, "d2", 2);
    expect(await nextA.sync()).toBe("synced");
    // The second deletion finds the old keyring gone: no error, no note left.
    expect(await nextB.sync()).toBe("synced");
    expect(await nextB.retiring()).toBe(false);
    // Each device on its keyring; B given A's key merges into it.
    const joined = await KeyringSession.adopt(
      options(b),
      nextA.ref,
      nextB.doc,
      true,
    );
    expect(await joined?.sync()).toBe("synced");
    expect(await stored(server, linkOf(nextA.ref))).toEqual(["d1", "d2"]);
  });

  // Security review of 18e: one slot for the keyring to delete lost the
  // first old keyring when the key was changed again before it was gone.
  test("changed twice before the first old keyring is deleted: both old keyrings go", async () => {
    const server = new FakeKeyringServer();
    const env = device(server);
    const first = await newSession(env, server);
    await first.sync();
    const second = await rotated(
      first,
      await createKeyring(ORIGIN, server.fetch),
    );
    // Offline: neither the sync nor the deletion happen.
    server.offline = true;
    expect(await second.sync()).toBe("offline");
    server.offline = false;
    const third = await rotated(
      second,
      await createKeyring(ORIGIN, server.fetch),
    );
    expect(await third.sync()).toBe("synced");
    expect(server.keyrings.has(linkOf(first.ref).keyringId)).toBe(false);
    expect(server.keyrings.has(linkOf(second.ref).keyringId)).toBe(false);
    expect(server.keyrings.has(linkOf(third.ref).keyringId)).toBe(true);
    expect(await third.retiring()).toBe(false);
  });

  test("an old keyring that is the current one again is never deleted", async () => {
    const server = new FakeKeyringServer();
    const env = device(server);
    const first = await newSession(env, server);
    await first.sync();
    const created = await createKeyring(ORIGIN, server.fetch);
    server.offline = true;
    const second = await rotated(first, created);
    expect(await second.sync()).toBe("offline");
    server.offline = false;
    // Back on the first key (pasted again, KR-30), the old one noted still.
    const back = await KeyringSession.adopt(
      options(env),
      first.ref,
      second.doc,
      true,
    );
    expect(await back?.sync()).toBe("synced");
    expect(server.keyrings.has(linkOf(first.ref).keyringId)).toBe(true);
  });

  // Analysis 18o.2, case 1: every tab of a device sees a sign-in end and
  // may attach at once; a tab may also write while another changes the
  // key. The copy stored is never overwritten by a tab that hasn't read
  // it (TR1).
  test("a document added by another tab of the device during a change of key is kept", async () => {
    const server = new FakeKeyringServer();
    const env = device(server);
    const first = await newSession(env, server);
    await write(first, "d1", 1);
    await first.sync();
    const tabA = await KeyringSession.open(options(env));
    const tabB = await KeyringSession.open(options(env));
    if (!tabA || !tabB) throw new Error("no keyring");
    await write(tabB, "d2", 2);

    const next = await KeyringSession.rotate(
      tabA,
      await createKeyring(ORIGIN, server.fetch),
    );

    expect(ids(next ?? tabA)).toEqual(["d1", "d2"]);
    const kept = await env.local.load();
    expect(
      kept && listKeyring(kept.doc ?? tabA.doc).map((e) => e.documentId),
    ).toEqual(["d1", "d2"]);
  });

  test("two tabs of a device changing to the same keyring at once lose nothing", async () => {
    const server = new FakeKeyringServer();
    const env = device(server);
    const first = await newSession(env, server);
    await write(first, "d1", 1);
    const tabA = await KeyringSession.open(options(env));
    const tabB = await KeyringSession.open(options(env));
    if (!tabA || !tabB) throw new Error("no keyring");
    await write(tabA, "dA", 2);
    await write(tabB, "dB", 3);
    // A writes once more: B hasn't read it.
    await write(tabA, "dA2", 4);
    const target = await createKeyring(ORIGIN, server.fetch);

    const [nextA, nextB] = await Promise.all([
      KeyringSession.rotate(tabA, target),
      KeyringSession.rotate(tabB, target),
    ]);

    expect(nextA && nextB).toBeTruthy();
    const kept = await env.local.load();
    expect(
      kept &&
        listKeyring(kept.doc ?? tabA.doc)
          .map((e) => e.documentId)
          .sort(),
    ).toEqual(["d1", "dA", "dA2", "dB"]);
    expect((await env.local.retired()).length).toBe(1);
  });

  test("a tab whose keyring another tab replaced by another one changes nothing", async () => {
    const server = new FakeKeyringServer();
    const env = device(server);
    const first = await newSession(env, server);
    await write(first, "d1", 1);
    const tabA = await KeyringSession.open(options(env));
    const tabB = await KeyringSession.open(options(env));
    if (!tabA || !tabB) throw new Error("no keyring");
    const chosenByA = await createKeyring(ORIGIN, server.fetch);
    await KeyringSession.rotate(tabA, chosenByA);

    const byB = await KeyringSession.rotate(
      tabB,
      await createKeyring(ORIGIN, server.fetch),
    );

    expect(byB).toBeUndefined();
    expect((await env.local.load())?.ref).toMatchObject({
      keyringId: chosenByA.keyringId,
    });
  });

  test("RA2: a tab left on the old keyring follows the new one: what it writes then is kept there", async () => {
    const server = new FakeKeyringServer();
    const env = device(server);
    const first = await newSession(env, server);
    await write(first, "d1", 1);
    const tabA = await KeyringSession.open(options(env));
    const tabB = await KeyringSession.open(options(env));
    if (!tabA || !tabB) throw new Error("no keyring");
    const next = await rotated(tabA, await createKeyring(ORIGIN, server.fetch));

    // Tab B still holds the old one: its write lands in the new one.
    expect(await write(tabB, "dB", 2)).toBe("saved");
    expect(sameKeyring(tabB.ref, next.ref)).toBe(true);
    const kept = await env.local.load();
    expect(kept && sameKeyring(kept.ref, next.ref)).toBe(true);
    expect(
      listKeyring(kept?.doc ?? newKeyringDoc())
        .map((e) => e.documentId)
        .sort(),
    ).toEqual(["d1", "dB"]);
    // And its next sync writes there, never into the old one.
    expect(await tabB.sync()).toBe("synced");
    expect((await stored(server, linkOf(next.ref)))?.sort()).toEqual([
      "d1",
      "dB",
    ]);
  });
});
