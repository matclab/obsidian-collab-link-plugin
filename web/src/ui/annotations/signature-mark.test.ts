// @vitest-environment jsdom
//
// The mark of a signed name (phase 18, decision 11; ADR-0051;
// docs/protocol/06-identity.md, ID-17, ID-39, ID-42): an icon, its label
// the key's short fingerprint, or the attestation's issuer; opened, the
// key, and the attested name, its address, its issuer, the attestation's
// validity; a word when there is something to say — the keys of its name,
// a revoked key, a late reception —, and, opened, what it means; the keys
// of the name listed, this one first, mine said, with what each signed.
import { flushSync, mount, unmount } from "svelte";
import { describe, expect, test } from "vitest";
import type { Verdict } from "../../../lib/src/index.js";
import { formatDate, t } from "../../i18n/index.js";
import {
  OWN_SIGNATURE,
  OwnSignature,
} from "../../view-model/own-signature.svelte.js";
import SignatureMark from "./SignatureMark.svelte";
import { SIGNER_KEYS, SignerKeys } from "./signer-keys.svelte.js";

const signed = {
  signed: true as const,
  fingerprint: new Uint8Array(32),
  short: "0a1b 2c3d 4e5f 6071",
  twoKeys: false,
};
const attestation = {
  id: "ab".repeat(32),
  issuer: "https://idp.example.org",
  sub: "248289761001",
  name: "Ada Lovelace",
  email: "ada@example.org",
  key: new Uint8Array(32),
  issuedAt: 1_792_159_267,
  expiresAt: 1_792_159_267 + 30 * 24 * 3600,
};

function shown(verdict: Verdict, own?: OwnSignature, keys?: SignerKeys) {
  const target = document.createElement("div");
  const context = new Map<symbol, unknown>();
  if (own) context.set(OWN_SIGNATURE, own);
  if (keys) context.set(SIGNER_KEYS, keys);
  const mark = mount(SignatureMark, {
    target,
    props: { verdict, name: "pseudonym" },
    context,
  });
  flushSync();
  const open = () => {
    target.querySelector<HTMLButtonElement>(".signature-mark")?.click();
    flushSync();
  };
  return { target, open, close: () => unmount(mark) };
}

describe("the mark of a signed name", () => {
  test("attested: an icon alone; opened, what the attestation says", () => {
    const s = shown({ ...signed, attested: attestation });
    const mark = s.target.querySelector(".signature-mark");
    expect(mark?.textContent?.trim()).toBe("");
    expect(mark?.querySelector(".icon")).not.toBeNull();
    expect(mark?.getAttribute("aria-label")).toBe(
      t().attestedNameLabel("Ada Lovelace", attestation.issuer),
    );
    s.open();
    const details = s.target.querySelector(".signature-details")?.textContent;
    expect(details).toContain(t().attestedAs("Ada Lovelace"));
    expect(details).toContain(t().attestedEmail("ada@example.org"));
    expect(details).toContain(t().attestedBy(attestation.issuer));
    expect(details).toContain(
      t().attestedValid(
        formatDate(attestation.issuedAt * 1000),
        formatDate(attestation.expiresAt * 1000),
      ),
    );
    expect(details).toContain(t().signedWith(signed.short));
    expect(details).not.toContain(t().keyRevoked(""));
    s.close();
  });

  test("a revoked key said, attested or not", () => {
    for (const verdict of [
      { ...signed, attested: attestation, revokedAt: 1_792_200_000 },
      { ...signed, revokedAt: 1_792_200_000 },
    ]) {
      const s = shown(verdict);
      expect(
        s.target.querySelector(".signature")?.classList.contains("warn"),
      ).toBe(true);
      s.open();
      expect(
        s.target.querySelector(".signature-details")?.textContent,
      ).toContain(t().keyRevoked(formatDate(1_792_200_000 * 1000)));
      s.close();
    }
  });

  test("signed only: an icon, the key in its label; opened, the key", () => {
    const s = shown(signed);
    const mark = s.target.querySelector(".signature-mark");
    expect(mark?.textContent?.trim()).toBe("");
    expect(mark?.getAttribute("aria-label")).toBe(
      t().signedNameLabel("pseudonym", signed.short),
    );
    s.open();
    const details = s.target.querySelector(".signature-details")?.textContent;
    expect(details).toContain(t().signedWith(signed.short));
    expect(details).toContain(t().signatureExplains);
    s.close();
  });

  const key = (n: number) => ({
    fingerprint: n.toString(16).repeat(64),
    short: `${n}${n}${n}${n} ${n}${n}${n}${n} ${n}${n}${n}${n} ${n}${n}${n}${n}`,
  });
  // This one's fingerprint, in hexadecimal: key(0)'s.
  const twoKeys = {
    ...signed,
    short: key(0).short,
    twoKeys: true,
    nameKeys: [key(0), key(1), key(2)],
  };

  test("the keys of its name: a word, its label too; what it means hidden until opened", () => {
    const s = shown(twoKeys);
    expect(s.target.querySelector(".signature-details")).toBeNull();
    expect(s.target.textContent).not.toContain(
      t().nameKeysTitle("pseudonym", 3),
    );
    const mark = s.target.querySelector(".signature-mark");
    expect(mark?.textContent).toContain(t().alertKeys(3));
    expect(mark?.getAttribute("aria-label")).toBe(
      t().withAlert(
        t().signedNameLabel("pseudonym", key(0).short),
        t().alertKeys(3),
      ),
    );
    expect(
      s.target.querySelector(".signature")?.classList.contains("warn"),
    ).toBe(true);
    s.close();
  });

  test("opened: what it means, each key of the name, this one first, mine said, what each signed", () => {
    const keys = new SignerKeys();
    keys.mine = new Set([key(2).fingerprint]);
    keys.signed = new Map([
      [key(0).fingerprint, ["a", "b"]],
      [key(2).fingerprint, ["c"]],
    ]);
    const s = shown(twoKeys, undefined, keys);
    s.open();
    const details = s.target.querySelector(".signature-details");
    expect(details?.textContent).toContain(t().nameKeysTitle("pseudonym", 3));
    expect(details?.textContent).toContain(t().nameKeysExplains);
    // What a key means in general: said by what two keys mean.
    expect(details?.textContent).not.toContain(t().signatureExplains);
    const rows = Array.from(
      details?.querySelectorAll(".signature-key") ?? [],
    ).map((row) => row.textContent ?? "");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain(key(0).short);
    expect(rows[0]).toContain(t().thisKey);
    expect(rows[0]).toContain(t().keySignedIn(2));
    expect(rows[1]).toContain(key(1).short);
    expect(rows[1]).toContain(t().keySignedIn(0));
    expect(rows[1]).not.toContain(t().yourKey);
    expect(rows[2]).toContain(key(2).short);
    expect(rows[2]).toContain(t().yourKey);
    expect(rows[2]).toContain(t().keySignedIn(1));
    s.close();
  });

  test("outside a panel (the history): the keys, without what each signed nor bringing it forward", () => {
    const s = shown(twoKeys);
    s.open();
    const rows = s.target.querySelectorAll(".signature-key");
    expect(rows).toHaveLength(3);
    expect(rows[1]?.textContent).not.toContain(t().keySignedIn(0));
    expect(s.target.querySelector(".key-highlight")).toBeNull();
    s.close();
  });

  test("ADR-0051 §4: each key brings forward what it signed, and back", () => {
    const keys = new SignerKeys();
    const s = shown(twoKeys, undefined, keys);
    s.open();
    const buttons = () =>
      Array.from(
        s.target.querySelectorAll<HTMLButtonElement>(".key-highlight"),
      );
    expect(buttons()).toHaveLength(3);
    expect(buttons()[1]?.getAttribute("aria-pressed")).toBe("false");
    expect(buttons()[1]?.getAttribute("aria-label")).toBe(
      t().highlightKey(key(1).short),
    );
    buttons()[1]?.click();
    flushSync();
    expect(keys.chosen).toEqual(key(1));
    expect(buttons()[1]?.getAttribute("aria-pressed")).toBe("true");
    expect(buttons()[0]?.getAttribute("aria-pressed")).toBe("false");
    buttons()[1]?.click();
    flushSync();
    expect(keys.chosen).toBeUndefined();
    s.close();
  });

  test("one word, the first that applies: revoked, the keys, late", () => {
    const late = { late: { dated: 1_000, received: 2 * 86_400_000 } };
    const word = (verdict: Verdict) => {
      const s = shown(verdict);
      const text = s.target.querySelector(".signature-alert-word")?.textContent;
      s.close();
      return text;
    };
    expect(word({ ...twoKeys, ...late, revokedAt: 1_792_200_000 })).toBe(
      t().alertRevoked,
    );
    expect(word({ ...twoKeys, ...late })).toBe(t().alertKeys(3));
    expect(word({ ...signed, ...late })).toBe(t().alertLate);
    // Attested: its name is the attestation's, not the one it carries.
    expect(word({ ...twoKeys, attested: attestation })).toBeUndefined();
    expect(word(signed)).toBeUndefined();
  });

  test("opened: what a revocation and a late reception mean", () => {
    const s = shown({
      ...signed,
      revokedAt: 1_792_200_000,
      late: { dated: 1_000, received: 2 * 86_400_000 },
    });
    s.open();
    const details = s.target.querySelector(".signature-details")?.textContent;
    expect(details).toContain(t().keyRevokedExplains);
    expect(details).toContain(t().signatureLateExplains);
    s.close();
  });

  // Analysis 18o.2: one's own comment, signed while signed in, says why
  // it doesn't carry the name; another's, nothing of the kind.
  test("one's own comment signed without the name says why", () => {
    const own = new OwnSignature();
    own.short = signed.short;
    own.reason = "Not yet: associate.";
    const mine = shown(signed, own);
    mine.open();
    expect(mine.target.querySelector(".signature-own")?.textContent).toContain(
      "Not yet: associate.",
    );
    mine.close();
    const theirs = shown({ ...signed, short: "ffff ffff ffff ffff" }, own);
    theirs.open();
    expect(theirs.target.querySelector(".signature-own")).toBeNull();
    theirs.close();
  });
});
