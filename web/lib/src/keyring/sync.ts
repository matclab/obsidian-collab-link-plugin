/** Keeping a keyring in step with the server (docs/protocol/05-keyring.md,
 * KR-25 – KR-28, docs/phase-18-trousseau-identite.md): read,
 * merge into the local copy, write naming the version read, again on
 * `412`. The transport is injected: this module knows blobs and versions,
 * not HTTP. The local copy is never replaced, only merged into: what it
 * holds stays in it whatever the server answers. */
import { LoroDoc } from "loro-crdt";
import { decryptKeyring, encryptKeyring } from "./crypto.js";
import { MAX_BLOB_BYTES } from "./limits.js";
import { readKeyringPlaintext } from "./model.js";

/** What a server of keyrings does (KR-6, KR-7), "missing" for `404`. A
 * network failure rejects. */
export interface KeyringTransport {
  read(): Promise<{ version: number; blob: Uint8Array } | "missing">;
  write(
    version: number,
    blob: Uint8Array,
  ): Promise<{ written: number } | { stale: number } | "missing">;
}

export type SyncOutcome =
  /** The server holds everything of the local copy, at this version. */
  | { kind: "synced"; version: number }
  /** The keyring is gone (cas 12): the local copy stays. */
  | { kind: "missing" }
  /** The stored blob doesn't decrypt, or Loro can't read it (KR-19,
   * KR-26): nothing written. */
  | { kind: "unreadable" }
  /** The blob would exceed the server's limit (KR-28): nothing written. */
  | { kind: "full" }
  /** Other devices kept writing first: try again later. */
  | { kind: "busy" };

export interface SyncOptions {
  /** Rounds of read, merge, write before giving up (default 5); a round
   * whose write was accepted while the copy moved on counts too. */
  attempts?: number;
  /** Waits after the `n`th `412` (from 1): injected, so that a test
   * controls the time. By default 100 ms × 2ⁿ⁻¹. */
  wait?: (round: number) => Promise<void>;
  /** Starting over (KR-45): a stored blob that doesn't read is written
   * over, at the version read, instead of `unreadable` — if this says so
   * when it is found, asked again at each such blob. One that reads is
   * merged as always. */
  overwrite?: boolean | (() => Promise<boolean>);
}

const defaultWait = (round: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, 100 * 2 ** (round - 1)));

/** Brings the server and `doc` in step: afterwards (`synced`), the stored
 * blob holds all `doc` held when it was encrypted, and `doc` all the
 * stored blob held (KR-25). */
export async function syncKeyring(
  doc: LoroDoc,
  key: Uint8Array,
  transport: KeyringTransport,
  options: SyncOptions = {},
): Promise<SyncOutcome> {
  const attempts = options.attempts ?? 5;
  const wait = options.wait ?? defaultWait;
  let refused = 0;
  for (let round = 0; round < attempts; round++) {
    if (refused > 0) await wait(refused);
    const stored = await transport.read();
    if (stored === "missing") return { kind: "missing" };
    let storedVersion = new LoroDoc().oplogVersion();
    /** Written over (KR-45): whatever the copy holds, it is written. */
    let over = false;
    if (stored.blob.length > 0) {
      let remote: LoroDoc | null;
      try {
        remote = readKeyringPlaintext(await decryptKeyring(key, stored.blob));
      } catch {
        remote = null;
      }
      if (remote) {
        // KR-26: read first in a fresh document, then merged.
        doc.import(remote.export({ mode: "update", from: doc.oplogVersion() }));
        storedVersion = remote.oplogVersion();
      } else if (
        typeof options.overwrite === "function"
          ? await options.overwrite()
          : options.overwrite
      ) {
        over = true;
      } else return { kind: "unreadable" };
    }
    const encrypted = doc.oplogVersion();
    // KR-27: nothing the server doesn't hold.
    if (!over && encrypted.compare(storedVersion) === 0) {
      return { kind: "synced", version: stored.version };
    }
    const blob = await encryptKeyring(key, doc.export({ mode: "snapshot" }));
    if (blob.length > MAX_BLOB_BYTES) return { kind: "full" };
    const written = await transport.write(stored.version, blob);
    if (written === "missing") return { kind: "missing" };
    if ("written" in written) {
      // A local write while this one went out is in the next round
      //.
      if (doc.oplogVersion().compare(encrypted) === 0) {
        return { kind: "synced", version: written.written };
      }
      continue;
    }
    refused += 1;
  }
  return { kind: "busy" };
}
