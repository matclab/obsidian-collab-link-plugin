// The keyring against the specification's vectors
// (docs/protocol/05-keyring.md §5.5 – §5.7, docs/protocol/vectors.json,
// section `keyring`): links, the verifier, the blob, what a keyring lists,
// deposits and pairing addresses (§5.10).
import { describe, expect, test } from "vitest";
import { fromHex, toHex, vectors } from "../test-support/vectors.js";
import {
  formatAccountKey,
  openAccountPairing,
  parseAccountKey,
} from "./account.js";
import { decryptKeyring, keyringVerifier, parseKeyringLink } from "./crypto.js";
import { listKeyring, readKeyringPlaintext } from "./model.js";
import { ownKeys } from "./own-keys.js";
import { openPairing, readPairingAddress } from "./pairing.js";

const { keyring } = vectors;

describe("the keyring, as the vectors say", () => {
  test("KR-2: the verifier of an access secret", async () => {
    for (const { secret, verifier } of keyring.verifiers) {
      expect(toHex(await keyringVerifier(fromHex(secret)))).toBe(verifier);
    }
  });

  test("KR-16: keyring links are read, or refused", () => {
    for (const { link, keyring_id, secret, key } of keyring.links) {
      const parsed = parseKeyringLink(link);
      expect({
        keyring_id: parsed.keyringId,
        secret: toHex(parsed.secret),
        key: toHex(parsed.key),
      }).toEqual({ keyring_id, secret, key });
    }
    for (const { why, link } of keyring.links_refused) {
      expect(() => parseKeyringLink(link), why).toThrow();
    }
  });

  test("KR-18, KR-19: the blob decrypts to its plaintext; an altered one doesn't", async () => {
    for (const { key, blob, plaintext } of keyring.blobs) {
      expect(toHex(await decryptKeyring(fromHex(key), fromHex(blob)))).toBe(
        plaintext,
      );
    }
    for (const blob of keyring.blobs_that_dont_decrypt) {
      await expect(
        decryptKeyring(fromHex(keyring.blobs[0].key), fromHex(blob)),
      ).rejects.toThrow();
    }
  });

  test("KR-20 – KR-22: a keyring lists its documents and their states", () => {
    const doc = readKeyringPlaintext(fromHex(keyring.documents.snapshot));
    expect(doc).not.toBeNull();
    const listed = listKeyring(doc as NonNullable<typeof doc>).map((e) => ({
      document_id: e.documentId,
      state: e.state,
      role: e.role,
      link: e.link,
      title: e.title,
      opened_at: e.openedAt,
      created_here: e.createdHere,
      excluded: e.excluded,
    }));
    expect(listed).toEqual(keyring.documents.entries);
  });

  test("KR-46: the other keys its person signed with", () => {
    const doc = readKeyringPlaintext(fromHex(keyring.own_keys.snapshot));
    if (!doc) throw new Error("the plaintext doesn't read");
    expect(ownKeys(doc).map(toHex).sort()).toEqual(
      [...keyring.own_keys.keys].sort(),
    );
  });

  test("KR-34, KR-36: deposits are read under the pairing key, or refused", async () => {
    const { pairing } = keyring;
    const key = fromHex(pairing.key);
    for (const {
      why,
      deposit,
      keyring_id,
      secret,
      link_key,
    } of pairing.deposits) {
      const opened = await openPairing(key, fromHex(deposit));
      expect(
        {
          keyring_id: opened.keyringId,
          secret: toHex(opened.secret),
          link_key: toHex(opened.key),
        },
        why,
      ).toEqual({ keyring_id, secret, link_key });
    }
    for (const { why, deposit } of pairing.deposits_refused) {
      await expect(openPairing(key, fromHex(deposit)), why).rejects.toThrow();
    }
  });

  test("KR-35: pairing addresses are read, refused, or name none", () => {
    const { pairing } = keyring;
    const read = (address: string) => {
      const url = new URL(address);
      return readPairingAddress(url.search, url.hash);
    };
    for (const { address, pairing_id, key } of pairing.addresses) {
      const got = read(address);
      expect({
        pairing_id: got?.pairingId,
        key: got && toHex(got.key),
        account: got?.account,
      }).toEqual({
        pairing_id,
        key,
        account: false,
      });
    }
    for (const { why, address } of pairing.addresses_refused) {
      expect(() => read(address), why).toThrow();
    }
    for (const address of pairing.not_pairing_addresses) {
      expect(read(address), address).toBeUndefined();
    }
  });

  test("KR-42: an account's key is read, or refused", () => {
    const { account } = keyring;
    for (const { why, key, value } of account.keys) {
      expect(toHex(parseAccountKey(key)), why ?? key).toBe(value);
    }
    for (const { why, key } of account.keys_refused) {
      expect(() => parseAccountKey(key), why).toThrow();
    }
    // Written as KR-42 says, read back.
    const value = fromHex(account.keys[0]?.value ?? "");
    expect(formatAccountKey(value)).toBe(account.keys[0]?.key);
  });

  test("KR-43: an account's deposits are read under the pairing key, or refused", async () => {
    const key = fromHex(keyring.pairing.key);
    for (const { why, deposit, value } of keyring.account.deposits) {
      const opened = await openAccountPairing(key, fromHex(deposit));
      expect(toHex(opened), why).toBe(value);
    }
    for (const { why, deposit } of keyring.account.deposits_refused) {
      await expect(
        openAccountPairing(key, fromHex(deposit)),
        why,
      ).rejects.toThrow();
    }
  });

  test("KR-43: an account's pairing addresses are read, or refused", () => {
    const read = (address: string) => {
      const url = new URL(address);
      return readPairingAddress(url.search, url.hash);
    };
    for (const { why, address, pairing_id, key, account } of keyring.account
      .addresses) {
      const got = read(address);
      expect(
        {
          pairing_id: got?.pairingId,
          key: got && toHex(got.key),
          account: got?.account,
        },
        why ?? address,
      ).toEqual({ pairing_id, key, account });
    }
    for (const { why, address } of keyring.account.addresses_refused) {
      expect(() => read(address), why).toThrow();
    }
  });
});
