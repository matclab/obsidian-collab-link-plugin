// Adding a device (docs/protocol/05-keyring.md, KR-34 – KR-36): the
// deposit reads back as the keyring link it seals, under its key only; the
// pairing address reads back as itself; and whatever a server or another
// client gives as a deposit is either a keyring link or refused — never an
// exception of another kind, never a link that isn't one.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import {
  encryptKeyring,
  formatKeyringLink,
  newKeyringSecrets,
  parseKeyringLink,
} from "./crypto.js";
import {
  UnreadableDeposit,
  formatPairingAddress,
  newPairingKey,
  openPairing,
  readPairingAddress,
  sealPairing,
} from "./pairing.js";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
type TC = Parameters<Parameters<typeof hegel.test>[0]>[0];

function link(tc: TC): string {
  return formatKeyringLink({
    keyringId: hex(tc.draw(gs.binary({ minSize: 16, maxSize: 16 }))),
    secret: tc.draw(gs.binary({ minSize: 32, maxSize: 32 })),
    key: tc.draw(gs.binary({ minSize: 32, maxSize: 32 })),
  });
}

/** A plaintext a deposit may hold: mostly the expected form, with one
 * thing changed. */
function hostilePlaintext(tc: TC): Uint8Array {
  const encode = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value));
  const valid = link(tc);
  const keyring = tc.draw(
    gs.sampledFrom<unknown>([
      valid,
      valid,
      valid,
      ` ${valid}\n`,
      valid.replace("v1", "v2"),
      `${valid}.x`,
      valid.slice(0, -1),
      tc.draw(gs.text({ maxSize: 40 })),
      tc.draw(gs.integers()),
      null,
    ]),
  );
  const v = tc.draw(
    gs.sampledFrom<unknown>([1, 1, 1, 2, 0, "1", 1.5, null, true]),
  );
  switch (tc.draw(gs.integers({ minValue: 0, maxValue: 9 }))) {
    case 0:
      return tc.draw(gs.binary({ maxSize: 64 }));
    case 1:
      return encode([v, keyring]);
    case 2:
      return encode({ keyring });
    case 3:
      return encode({ v, keyring, other: tc.draw(gs.text({ maxSize: 8 })) });
    case 4:
      return new Uint8Array([...encode({ v, keyring }), 0xff]);
    case 5:
      return encode(tc.draw(gs.text({ maxSize: 20 })));
    default:
      return encode({ v, keyring });
  }
}

describe("adding a device", () => {
  test("KR-34, KR-36: a deposit opens, under its key only, as its link", () =>
    hegel.testAsync(async (tc) => {
      const given = link(tc);
      const key = newPairingKey();
      const deposit = await sealPairing(key, given);
      const opened = await openPairing(key, deposit);
      expect(formatKeyringLink(opened)).toBe(given);
      await expect(openPairing(newPairingKey(), deposit)).rejects.toThrow();
    }));

  test("KR-35: a pairing address reads back as itself", () =>
    hegel.test((tc) => {
      const pairingId = hex(tc.draw(gs.binary({ minSize: 16, maxSize: 16 })));
      const key = tc.draw(gs.binary({ minSize: 32, maxSize: 32 }));
      const url = new URL(
        formatPairingAddress("https://collab.example.org", pairingId, key),
      );
      expect(url.origin + url.pathname).toBe("https://collab.example.org/");
      const read = readPairingAddress(url.search, url.hash);
      expect([read?.pairingId, read && hex(read.key)]).toEqual([
        pairingId,
        hex(key),
      ]);
    }));

  test("KR-36: any deposit is a keyring link or refused, nothing else", () =>
    hegel.testAsync(async (tc) => {
      const key = newPairingKey();
      const plaintext = hostilePlaintext(tc);
      const deposit =
        tc.draw(gs.integers({ minValue: 0, maxValue: 3 })) > 0
          ? await encryptKeyring(key, plaintext)
          : tc.draw(gs.binary({ maxSize: 96 }));
      let opened: ReturnType<typeof parseKeyringLink> | undefined;
      try {
        opened = await openPairing(key, deposit);
      } catch (error) {
        // Refused as unreadable, whatever the reason.
        expect(error).toBeInstanceOf(UnreadableDeposit);
        return;
      }
      // Accepted: then it was the expected form.
      const json = JSON.parse(new TextDecoder().decode(plaintext));
      expect(json.v).toBe(1);
      expect(formatKeyringLink(opened)).toBe(
        formatKeyringLink(parseKeyringLink(json.keyring)),
      );
    }));
});
