// The token an account's keyring is read and written with (analysis 18i.3;
// KR-44, TR7): the one kept on this device, only if it is of the same
// gateway and account; never another account's.
import { describe, expect, test } from "vitest";
import { memoryAccountLocal } from "../account/test-support.js";
import { accountToken } from "./environment.js";
import type { AccountKeyring } from "./ref.js";

const ref: AccountKeyring = {
  gateway: "https://accounts.example",
  issuer: "https://idp.example",
  sub: "u-1",
  key: new Uint8Array(32),
};
const kept = {
  gateway: ref.gateway,
  token: "T",
  deadline: 10,
  name: "Ada",
  email: null,
  issuer: ref.issuer,
  sub: ref.sub,
};

describe("the token of an account's keyring", () => {
  test("the account's own, and only it (TR7)", async () => {
    const local = memoryAccountLocal();
    expect(await accountToken(local, ref)).toBeUndefined();
    local.stored = kept;
    expect(await accountToken(local, ref)).toBe("T");
    for (const other of [
      { ...kept, sub: "u-2" },
      { ...kept, issuer: "https://other-idp.example" },
      { ...kept, gateway: "https://other.example" },
    ]) {
      local.stored = other;
      expect(await accountToken(local, ref)).toBeUndefined();
    }
  });
});
