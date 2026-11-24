// The identity line of the document menu (analysis 18o.2): what the page
// says of the identity and of what it signs, and the gesture that makes
// the name appear — from the sign-in, the list here, the attestation.
import { describe, expect, test } from "vitest";
import type { AttestorState } from "../../account/attestor.js";
import type { AccountState } from "../../account/sign-in.js";
import type { DocumentSituation } from "../../keyring/document-association.js";
import { chipOf, identityLine, notYetOf, reasonOf } from "./identity-line.js";

const ada: AccountState = {
  kind: "signed-in",
  name: "Ada Lovelace",
  email: "ada@example.org",
  issuer: "https://idp.example",
  sub: "u-1",
};

describe("the identity line", () => {
  test("no gateway: nothing", () => {
    expect(
      identityLine({
        account: { kind: "unavailable" },
        list: { kind: "signed-out" },
      }),
    ).toEqual({ kind: "hidden" });
  });

  test("signed out: « S'identifier »; signing in: pending", () => {
    expect(
      identityLine({
        account: { kind: "signed-out", ready: true },
        list: { kind: "signed-out" },
      }),
    ).toEqual({ kind: "sign-in", ready: true });
    expect(
      identityLine({
        account: { kind: "pending" },
        list: { kind: "signed-out" },
      }),
    ).toEqual({ kind: "pending" });
  });

  test("signed in, the list the identity's, attested: the name", () => {
    expect(
      identityLine({
        account: ada,
        list: { kind: "associated" },
        attestation: "attested",
        orgName: "Démo",
      }),
    ).toEqual({
      kind: "attested",
      org: "Démo",
      who: "Ada Lovelace (ada@example.org)",
    });
  });

  test("signed in, not yet the name: the reason and the gesture", () => {
    const who = "Ada Lovelace (ada@example.org)";
    const cases: [DocumentSituation, AttestorState | undefined, string][] = [
      [{ kind: "ask", count: 2, titles: [] }, undefined, "associate"],
      [{ kind: "open-here", count: 0 }, undefined, "open-here"],
      [
        {
          kind: "other",
          identity: { gateway: "g", issuer: "i", sub: "s" },
          count: 1,
          titles: [],
        },
        undefined,
        "other",
      ],
      [{ kind: "associated" }, "needs-recent", "confirm"],
      [{ kind: "associated" }, "refused", "refused"],
    ];
    for (const [list, attestation, kind] of cases) {
      expect(
        identityLine({
          account: ada,
          list,
          ...(attestation && { attestation }),
        }),
        `${list.kind} ${attestation}`,
      ).toEqual({ kind, who });
    }
  });

  test("signed in, the list or the attestation not known: said, to try again", () => {
    for (const [list, attestation] of [
      [{ kind: "unknown" }, undefined],
      [{ kind: "associated" }, "unattested"],
    ] as const) {
      expect(
        identityLine({ account: ada, list, attestation }),
        `${list.kind} ${attestation}`,
      ).toEqual({
        kind: "unconfirmed",
        who: "Ada Lovelace (ada@example.org)",
      });
    }
    expect(reasonOf({ kind: "unconfirmed", who: "Ada Lovelace" })).toContain(
      "could not be confirmed",
    );
  });

  test("signed in, nothing known yet: the identity alone", () => {
    for (const [list, attestation] of [
      [{ kind: "automatic" }, undefined],
      [{ kind: "associated" }, undefined],
      [{ kind: "signed-out" }, undefined],
    ] as const) {
      expect(
        identityLine({ account: ada, list, attestation }),
        `${list.kind} ${attestation}`,
      ).toEqual({ kind: "signed-in", who: "Ada Lovelace (ada@example.org)" });
    }
  });

  test("what is asked before signing (18o.3, IC4): confirm, try again, the home page", () => {
    const who = "Ada";
    expect(notYetOf({ kind: "confirm", who })).toBe("confirm");
    expect(notYetOf({ kind: "unconfirmed", who })).toBe("unconfirmed");
    for (const kind of ["associate", "open-here", "other"] as const) {
      expect(notYetOf({ kind, who })).toBe("home");
    }
    expect(notYetOf({ kind: "attested", who })).toBeUndefined();
    expect(notYetOf({ kind: "refused", who })).toBeUndefined();
    expect(notYetOf({ kind: "signed-in", who })).toBeUndefined();
  });

  test("the chip of the bar says what is to do at the home page (18p.2)", () => {
    const who = "Ada";
    for (const kind of [
      "confirm",
      "unconfirmed",
      "associate",
      "open-here",
      "other",
    ] as const) {
      expect(chipOf({ kind, who })).toBe(kind);
    }
    expect(chipOf({ kind: "attested", who })).toBeUndefined();
    expect(chipOf({ kind: "signed-in", who })).toBeUndefined();
  });

  // Phase 30, NK6: the key refused, the gesture is a new key — in the
  // line, and in the bar's chip; said offline when the list couldn't sync.
  test("NK6: refused, the chip draws a new key; the replacement's state in the line", () => {
    const who = "Ada";
    expect(chipOf({ kind: "refused", who })).toBe("new-key");
    expect(
      identityLine({
        account: ada,
        list: { kind: "associated" },
        attestation: "refused",
        replacing: "offline",
      }),
    ).toEqual({
      kind: "refused",
      who: "Ada Lovelace (ada@example.org)",
      replacing: "offline",
    });
    // Only where the refusal is said.
    expect(
      identityLine({
        account: ada,
        list: { kind: "associated" },
        attestation: "attested",
        replacing: "busy",
      }).kind,
    ).toBe("attested");
  });

  // IC5, precised (2026-10-30): signed out, the sign-in in the bar too,
  // once the click opens the window at once; the sign-in under way, to
  // cancel. No gateway, nothing.
  test("signed out, the chip signs in; signing in, it cancels", () => {
    expect(chipOf({ kind: "sign-in", ready: true })).toBe("sign-in");
    expect(chipOf({ kind: "sign-in", ready: false })).toBeUndefined();
    expect(chipOf({ kind: "pending" })).toBe("pending");
    expect(chipOf({ kind: "hidden" })).toBeUndefined();
  });
});
