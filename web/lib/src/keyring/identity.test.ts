// The identity key a keyring holds (docs/protocol/05-keyring.md, KR-38):
// one value of 80 bytes, so that two devices that each write one keep one
// of them whole; anything else is no key.
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { exportPrivateKey, generateIdentityKey } from "../identity/keys.js";
import { keyringIdentity, setKeyringIdentity } from "./identity.js";
import { newKeyringDoc } from "./model.js";

async function drawn() {
  const key = await generateIdentityKey({ extractable: true });
  return {
    pkcs8: await exportPrivateKey(key.privateKey),
    publicKey: key.publicKey,
  };
}

describe("a keyring's identity key", () => {
  test("KR-38: written, read back", async () => {
    const doc = newKeyringDoc();
    expect(keyringIdentity(doc)).toBeNull();
    const key = await drawn();
    setKeyringIdentity(doc, key.pkcs8, key.publicKey);
    expect(keyringIdentity(doc)).toEqual(key);
  });

  test("KR-38: two devices that each write one keep one of them whole", async () => {
    const a = newKeyringDoc();
    const b = new LoroDoc();
    b.import(a.export({ mode: "snapshot" }));
    const ka = await drawn();
    const kb = await drawn();
    setKeyringIdentity(a, ka.pkcs8, ka.publicKey);
    setKeyringIdentity(b, kb.pkcs8, kb.publicKey);
    a.import(b.export({ mode: "update" }));
    b.import(a.export({ mode: "update" }));
    const kept = keyringIdentity(a);
    expect([ka, kb]).toContainEqual(kept);
    expect(keyringIdentity(b)).toEqual(kept);
  });

  test("KR-38: anything else is no key", async () => {
    const key = await drawn();
    const cases = [
      key.pkcs8,
      new Uint8Array([...key.pkcs8, ...key.publicKey, 0]),
      new Uint8Array([0, ...key.pkcs8.slice(1), ...key.publicKey]),
      new Uint8Array([...key.pkcs8, ...new Uint8Array(32)]),
      "text",
      12,
    ];
    for (const value of cases) {
      const doc = newKeyringDoc();
      doc.getMap("identity").set("ed25519", value as never);
      doc.commit();
      expect(keyringIdentity(doc), String(value)).toBeNull();
    }
  });
});
