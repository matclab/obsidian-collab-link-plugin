// Which keyring a device holds (analysis 18i.3): a keyring link, or an
// account — its gateway, issuer, sub and K_t. Kept as text in oc:keyring,
// read back as itself; anything else is no keyring.
import { describe, expect, test } from "vitest";
import { formatKeyringLink, newKeyringSecrets } from "../../lib/src/index.js";
import {
  type AccountKeyring,
  formatKeyringRef,
  isAccountKeyring,
  parseKeyringRef,
  sameKeyring,
} from "./ref.js";

const account = (sub = "u-1"): AccountKeyring => ({
  gateway: "https://accounts.example",
  issuer: "https://idp.example",
  sub,
  key: new Uint8Array(32).fill(7),
});
const link = { keyringId: "ab".repeat(16), ...newKeyringSecrets() };

describe("which keyring a device holds", () => {
  test("a link and an account read back as themselves", () => {
    expect(formatKeyringRef(link)).toBe(formatKeyringLink(link));
    expect(parseKeyringRef(formatKeyringRef(link))).toEqual(link);
    const read = parseKeyringRef(formatKeyringRef(account()));
    expect(read).toEqual(account());
    expect(isAccountKeyring(read)).toBe(true);
    expect(isAccountKeyring(link)).toBe(false);
  });

  test("the same keyring: same link, or same account and key", () => {
    expect(sameKeyring(account(), account())).toBe(true);
    expect(sameKeyring(account(), account("u-2"))).toBe(false);
    expect(
      sameKeyring(account(), { ...account(), key: new Uint8Array(32) }),
    ).toBe(false);
    expect(sameKeyring(account(), link)).toBe(false);
    expect(sameKeyring(link, { ...link })).toBe(true);
  });

  test("anything else is refused", () => {
    for (const text of [
      "",
      "oc-account:",
      "oc-account:{}",
      'oc-account:["g","i","s"]',
      'oc-account:["g","i","s","short"]',
      'oc-account:["g","i",3,"BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc"]',
      "oc-keyring:v1:only-one-part",
    ]) {
      expect(() => parseKeyringRef(text), text).toThrow(Error);
    }
  });
});
