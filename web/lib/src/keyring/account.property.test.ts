// The keyring of an account (docs/protocol/05-keyring.md, KR-42, KR-43):
// its key and its deposit read back as themselves; whatever a gateway or
// another client gives as a deposit is a key of 32 bytes or refused, and
// whatever text is pasted is a key of 32 bytes or an error — never an
// exception of another kind.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import { bytesToBase64Url } from "../crypto/role-secrets.js";
import {
  formatAccountKey,
  openAccountPairing,
  parseAccountKey,
  sealAccountPairing,
} from "./account.js";
import { encryptKeyring } from "./crypto.js";
import {
  UnreadableDeposit,
  formatPairingAddress,
  newPairingKey,
  readPairingAddress,
} from "./pairing.js";

type TC = Parameters<Parameters<typeof hegel.test>[0]>[0];

function hostilePlaintext(tc: TC): Uint8Array {
  const encode = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value));
  const valid = bytesToBase64Url(
    tc.draw(gs.binary({ minSize: 32, maxSize: 32 })),
  );
  const key = tc.draw(
    gs.sampledFrom<unknown>([
      valid,
      valid,
      `${valid}=`,
      valid.slice(1),
      `oc-keyring:v1:${valid}`,
      tc.draw(gs.text({ maxSize: 50 })),
      tc.draw(gs.integers()),
      null,
    ]),
  );
  const v = tc.draw(gs.sampledFrom<unknown>([1, 1, 1, 2, "1", null]));
  switch (tc.draw(gs.integers({ minValue: 0, maxValue: 6 }))) {
    case 0:
      return tc.draw(gs.binary({ maxSize: 64 }));
    case 1:
      return encode([v, key]);
    case 2:
      return encode({ v, keyring: key });
    case 3:
      return new Uint8Array([...encode({ v, key }), 0xff]);
    default:
      return encode({ v, key });
  }
}

describe("the keyring of an account", () => {
  test("KR-42: a key reads back as itself", () =>
    hegel.test((tc) => {
      const key = new Uint8Array(
        tc.draw(gs.binary({ minSize: 32, maxSize: 32 })),
      );
      const space = tc.draw(gs.sampledFrom(["", " ", "\n", "\t "]));
      expect(
        parseAccountKey(`${space}${formatAccountKey(key)}${space}`),
      ).toEqual(key);
    }));

  test("KR-42: pasted text is a key of 32 bytes, or an Error", () =>
    hegel.test((tc) => {
      const text = tc.draw(
        gs.oneOf(
          gs.text({ maxSize: 80 }),
          gs.text({ maxSize: 50 }).map((t) => `oc-keyring:v1:${t}`),
        ),
      );
      let key: Uint8Array | undefined;
      try {
        key = parseAccountKey(text);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        return;
      }
      expect(key).toHaveLength(32);
      expect(parseAccountKey(formatAccountKey(key))).toEqual(key);
    }));

  test("KR-43: a deposit opens, under its key only, as its key", () =>
    hegel.testAsync(async (tc) => {
      const given = new Uint8Array(
        tc.draw(gs.binary({ minSize: 32, maxSize: 32 })),
      );
      const pairingKey = newPairingKey();
      const deposit = await sealAccountPairing(pairingKey, given);
      expect(await openAccountPairing(pairingKey, deposit)).toEqual(given);
      await expect(
        openAccountPairing(newPairingKey(), deposit),
      ).rejects.toBeInstanceOf(UnreadableDeposit);
    }));

  test("KR-43: a hostile deposit is a key of 32 bytes or UnreadableDeposit", () =>
    hegel.testAsync(async (tc) => {
      const pairingKey = newPairingKey();
      const deposit = await encryptKeyring(pairingKey, hostilePlaintext(tc));
      let opened: Uint8Array;
      try {
        opened = await openAccountPairing(pairingKey, deposit);
      } catch (error) {
        expect(error).toBeInstanceOf(UnreadableDeposit);
        return;
      }
      expect(opened).toHaveLength(32);
    }));

  test("KR-43: an account's pairing address reads back as itself", () =>
    hegel.test((tc) => {
      const pairingId = Buffer.from(
        tc.draw(gs.binary({ minSize: 16, maxSize: 16 })),
      ).toString("hex");
      const key = newPairingKey();
      const account = tc.draw(gs.booleans());
      const url = new URL(
        formatPairingAddress("https://collab.example.org", pairingId, key, {
          account,
        }),
      );
      expect(readPairingAddress(url.search, url.hash)).toEqual({
        pairingId,
        key,
        account,
      });
    }));
});
