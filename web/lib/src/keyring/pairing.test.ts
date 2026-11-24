// The pairing address and deposit (docs/protocol/05-keyring.md, KR-34 –
// KR-36): the forms refused, by example.
import { describe, expect, test } from "vitest";
import { bytesToBase64Url } from "../crypto/role-secrets.js";
import { encryptKeyring, formatKeyringLink } from "./crypto.js";
import { openPairing, readPairingAddress } from "./pairing.js";

const ID = "0123456789abcdef0123456789abcdef";
const P = bytesToBase64Url(new Uint8Array(32).fill(7));
const LINK = formatKeyringLink({
  keyringId: "ab".repeat(16),
  secret: new Uint8Array(32).fill(1),
  key: new Uint8Array(32).fill(2),
});

describe("the pairing address", () => {
  test("no `pair`: not a pairing address", () => {
    expect(readPairingAddress("", "")).toBeUndefined();
    expect(readPairingAddress("?doc=x", `#p=${P}`)).toBeUndefined();
  });

  test("KR-35: refused unless one well-formed `pair` and `#p=<32 bytes>`", () => {
    expect(readPairingAddress(`?pair=${ID}`, `#p=${P}`)?.pairingId).toBe(ID);
    for (const [search, hash] of [
      [`?pair=${ID.toUpperCase()}`, `#p=${P}`],
      [`?pair=${ID}&pair=${ID}`, `#p=${P}`],
      [`?pair=${ID.slice(1)}`, `#p=${P}`],
      [`?pair=${ID}`, ""],
      [`?pair=${ID}`, `#p=${P.slice(1)}`],
      [`?pair=${ID}`, `#p=${P}A`],
      [`?pair=${ID}`, `#p=${P}&x=1`],
      [`?pair=${ID}`, `#q=${P}`],
      [`?pair=${ID}`, `#p=${P.slice(0, -1)}=`],
    ] as const) {
      expect(
        () => readPairingAddress(search, hash),
        `${search}${hash}`,
      ).toThrow();
    }
  });
});

describe("the deposit", () => {
  const key = new Uint8Array(32).fill(7);
  const seal = (text: string) =>
    encryptKeyring(key, new TextEncoder().encode(text));

  test("KR-36: other members are ignored", async () => {
    const opened = await openPairing(
      key,
      await seal(JSON.stringify({ v: 1, keyring: LINK, more: [1] })),
    );
    expect(formatKeyringLink(opened)).toBe(LINK);
  });

  test("KR-36: anything else is refused", async () => {
    for (const text of [
      JSON.stringify({ v: 2, keyring: LINK }),
      JSON.stringify({ v: "1", keyring: LINK }),
      JSON.stringify({ keyring: LINK }),
      JSON.stringify({ v: 1 }),
      JSON.stringify({ v: 1, keyring: `${LINK}x` }),
      JSON.stringify([1, LINK]),
      JSON.stringify(LINK),
      "not json",
      "",
    ]) {
      await expect(openPairing(key, await seal(text)), text).rejects.toThrow();
    }
    const invalidUtf8 = await encryptKeyring(
      key,
      new Uint8Array([0x7b, 0xff, 0x7d]),
    );
    await expect(openPairing(key, invalidUtf8)).rejects.toThrow();
  });
});
