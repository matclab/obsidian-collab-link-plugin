// The other keys a person signed with (docs/protocol/05-keyring.md, KR-46;
// ADR-0050 §3): listed from `keys`, added once, never removed.
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { bytesToBase64Url } from "../crypto/role-secrets.js";
import { newKeyringDoc, removeDocument } from "./model.js";
import { addOwnKey, ownKeys } from "./own-keys.js";

const A = new Uint8Array(32).fill(0xa0);
const B = new Uint8Array(32).fill(0xb0);
// A point of small order (ID-6, 2): not acceptable.
const SMALL = new Uint8Array(32);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("the keys of a keyring (KR-46)", () => {
  test("none in a new keyring", () => {
    expect(ownKeys(newKeyringDoc())).toEqual([]);
  });

  test("added once, with when; adding again changes nothing", () => {
    const doc = newKeyringDoc();
    expect(addOwnKey(doc, A, 100)).toBe(true);
    const version = doc.oplogVersion();
    expect(addOwnKey(doc, A, 200)).toBe(false);
    expect(doc.oplogVersion().compare(version)).toBe(0);
    expect(ownKeys(doc).map(hex)).toEqual([hex(A)]);
    expect(doc.getMap("keys").get(bytesToBase64Url(A))).toBe(100);
  });

  test("an unacceptable key isn't added", () => {
    const doc = newKeyringDoc();
    expect(addOwnKey(doc, SMALL, 1)).toBe(false);
    expect(addOwnKey(doc, A.slice(0, 31), 1)).toBe(false);
    expect(ownKeys(doc)).toEqual([]);
  });

  test("two devices adding theirs keep both", () => {
    const one = newKeyringDoc();
    const other = new LoroDoc();
    other.import(one.export({ mode: "snapshot" }));
    addOwnKey(one, A, 1);
    addOwnKey(other, B, 2);
    one.import(other.export({ mode: "update" }));
    expect(ownKeys(one).map(hex).sort()).toEqual([hex(A), hex(B)].sort());
  });

  test("what isn't a key of 32 acceptable bytes under an integer is ignored", () => {
    const doc = newKeyringDoc();
    const keys = doc.getMap("keys");
    keys.set(bytesToBase64Url(A), 1);
    keys.set(bytesToBase64Url(B), "yesterday");
    keys.set(bytesToBase64Url(A.slice(0, 31)), 1);
    keys.set(bytesToBase64Url(SMALL), 1);
    keys.set("not base64url!", 1);
    keys.set(`${bytesToBase64Url(B)}=`, 1);
    keys.set(bytesToBase64Url(B), 1.5);
    doc.commit();
    expect(ownKeys(doc).map(hex)).toEqual([hex(A)]);
  });

  test("two spellings of one key (padding bits set, K-2): listed once", () => {
    const doc = newKeyringDoc();
    const name = bytesToBase64Url(A);
    // 0xa0…: its last character is "A"; with its two padding bits, "D".
    expect(name.at(-1)).toBe("A");
    doc.getMap("keys").set(name, 1);
    doc.getMap("keys").set(`${name.slice(0, -1)}D`, 2);
    doc.commit();
    expect(ownKeys(doc).map(hex)).toEqual([hex(A)]);
  });

  test("a `keys` that isn't a map: none", () => {
    const doc = newKeyringDoc();
    doc.getList("keys").push(bytesToBase64Url(A));
    doc.commit();
    expect(ownKeys(doc)).toEqual([]);
  });

  test("removing a document leaves the keys (KR-23)", () => {
    const doc = newKeyringDoc();
    addOwnKey(doc, A, 1);
    removeDocument(doc, "d1");
    expect(ownKeys(doc).map(hex)).toEqual([hex(A)]);
  });
});
