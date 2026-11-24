// Writing over a keyring that doesn't read (docs/protocol/05-keyring.md,
// KR-19, KR-45; docs/phase-18-trousseau-identite.md, analysis 18p.3, RL3).
import { describe, expect, test } from "vitest";
import { encryptKeyring, newKeyringSecrets } from "./crypto.js";
import { decryptKeyring } from "./crypto.js";
import { listKeyring, newKeyringDoc, rememberLink } from "./model.js";
import { readKeyringPlaintext } from "./model.js";
import { type KeyringTransport, syncKeyring } from "./sync.js";
import { testLink } from "./test-support/links.js";

/** One keyring in memory; `between` runs once, before the first write is
 * taken: another device's write. */
function server(blob: Uint8Array, between?: (s: Stored) => void) {
  const stored: Stored = { version: 3, blob };
  let once = between;
  const transport: KeyringTransport = {
    read: async () => ({ version: stored.version, blob: stored.blob }),
    write: async (version, next) => {
      once?.(stored);
      once = undefined;
      if (version !== stored.version) return { stale: stored.version };
      stored.version += 1;
      stored.blob = next;
      return { written: stored.version };
    },
  };
  return { stored, transport };
}
interface Stored {
  version: number;
  blob: Uint8Array;
}

async function listOf(key: Uint8Array, blob: Uint8Array) {
  const doc = readKeyringPlaintext(await decryptKeyring(key, blob));
  return doc ? listKeyring(doc).map((e) => e.documentId) : undefined;
}

describe("syncKeyring over a keyring that doesn't read", () => {
  const theirs = newKeyringSecrets().key;
  const mine = newKeyringSecrets().key;
  const unreadable = async () =>
    encryptKeyring(theirs, newKeyringDoc().export({ mode: "snapshot" }));

  test("without overwrite, nothing is written (KR-19)", async () => {
    const { stored, transport } = server(await unreadable());
    const doc = newKeyringDoc();
    rememberLink(doc, testLink("d1"), { at: 1 });
    const outcome = await syncKeyring(doc, mine, transport);
    expect(outcome).toEqual({ kind: "unreadable" });
    expect(stored.version).toBe(3);
  });

  test("with overwrite, the copy is written at the version read", async () => {
    const { stored, transport } = server(await unreadable());
    const doc = newKeyringDoc();
    rememberLink(doc, testLink("d1"), { at: 1 });
    const outcome = await syncKeyring(doc, mine, transport, {
      overwrite: true,
    });
    expect(outcome).toEqual({ kind: "synced", version: 4 });
    expect(await listOf(mine, stored.blob)).toEqual(["d1"]);
  });

  test("with overwrite, an empty copy is written too", async () => {
    const { stored, transport } = server(await unreadable());
    const outcome = await syncKeyring(newKeyringDoc(), mine, transport, {
      overwrite: true,
    });
    expect(outcome).toEqual({ kind: "synced", version: 4 });
    expect(await listOf(mine, stored.blob)).toEqual([]);
  });

  test("with overwrite, a write in between that doesn't read is written over again", async () => {
    const other = await unreadable();
    const { stored, transport } = server(await unreadable(), (s) => {
      s.version += 1;
      s.blob = other;
    });
    const doc = newKeyringDoc();
    rememberLink(doc, testLink("d1"), { at: 1 });
    const outcome = await syncKeyring(doc, mine, transport, {
      overwrite: true,
      wait: async () => {},
    });
    expect(outcome).toEqual({ kind: "synced", version: 5 });
    expect(await listOf(mine, stored.blob)).toEqual(["d1"]);
  });

  test("with overwrite, a keyring that reads is merged, never replaced", async () => {
    const before = newKeyringDoc();
    rememberLink(before, testLink("d0"), { at: 1 });
    const { stored, transport } = server(
      await encryptKeyring(mine, before.export({ mode: "snapshot" })),
    );
    const doc = newKeyringDoc();
    rememberLink(doc, testLink("d1"), { at: 2 });
    await syncKeyring(doc, mine, transport, { overwrite: true });
    expect((await listOf(mine, stored.blob))?.sort()).toEqual(["d0", "d1"]);
  });

  test("asked as it is found: a list no longer started over isn't written over", async () => {
    const { stored, transport } = server(await unreadable());
    const asked: number[] = [];
    const outcome = await syncKeyring(newKeyringDoc(), mine, transport, {
      overwrite: async () => {
        asked.push(stored.version);
        return false;
      },
    });
    expect(outcome).toEqual({ kind: "unreadable" });
    expect(asked).toEqual([3]);
    expect(stored.version).toBe(3);
  });
});
