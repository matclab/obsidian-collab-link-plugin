// What the plugin trusts of a gateway (docs/phase-18-trousseau-identite.md,
// analysis 18m, M3, OB3): the gateway and the attestation keys'
// fingerprints of the settings, read strictly; nothing of them if
// anything there is not usable, never a fingerprint guessed.
import { describe, expect, test } from "vitest";
import { readFingerprints, trustSettings } from "./trust-settings.js";

const A = "a".repeat(64);
const B = "0123456789abcdef".repeat(4);

describe("the fingerprints of the settings", () => {
  test("one per line, blank lines and spaces around ignored", () => {
    expect(readFingerprints(`${A}\n\n  ${B}  \n`)).toEqual({
      ok: true,
      keys: [A, B],
    });
    expect(readFingerprints("")).toEqual({ ok: true, keys: [] });
  });

  test("uppercase is read as lowercase; the same one twice, once", () => {
    expect(readFingerprints(`${B.toUpperCase()}\n${B}`)).toEqual({
      ok: true,
      keys: [B],
    });
  });

  test("a line not of 64 hexadecimal digits is told, by its number", () => {
    for (const bad of [A.slice(1), `${A}0`, `${A.slice(1)}g`, `${A} ${B}`]) {
      expect(readFingerprints(`${B}\n\n${bad}`), bad).toEqual({
        ok: false,
        line: 3,
      });
    }
  });
});

describe("the trust of the settings (OB3)", () => {
  const read = (values: Record<string, unknown>) =>
    trustSettings((name) => values[name]);

  test("a gateway and its fingerprints", () => {
    expect(
      read({
        gateway: "https://accounts.example.org/",
        attestationKeys: `${A}\n${B}`,
        orgName: "Systerel",
      }),
    ).toEqual({
      gateway: "https://accounts.example.org",
      attestationKeys: [A, B],
      orgName: "Systerel",
    });
  });

  test("no fingerprint, or one not usable: nothing is attested", () => {
    expect(read({ gateway: "https://accounts.example.org" })).toBeUndefined();
    expect(
      read({ gateway: "https://accounts.example.org", attestationKeys: "x" }),
    ).toBeUndefined();
    expect(read({ attestationKeys: 7 })).toBeUndefined();
  });

  test("fingerprints without a gateway: attested names read, no sign-in", () => {
    expect(read({ attestationKeys: A })).toEqual({ attestationKeys: [A] });
  });

  test("a gateway in clear across the network is none", () => {
    expect(
      read({ gateway: "http://accounts.example.org", attestationKeys: A }),
    ).toEqual({ attestationKeys: [A] });
    expect(
      read({ gateway: "http://localhost:8081", attestationKeys: A }),
    ).toEqual({ gateway: "http://localhost:8081", attestationKeys: [A] });
  });

  test("an organisation's name not of its form is not shown", () => {
    for (const orgName of ["", " Systerel", "a‮b", "x".repeat(65), 3]) {
      expect(read({ attestationKeys: A, orgName })).toEqual({
        attestationKeys: [A],
      });
    }
  });
});
