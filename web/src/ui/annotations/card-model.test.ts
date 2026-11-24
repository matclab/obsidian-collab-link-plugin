import { describe, expect, test } from "vitest";
import {
  type CardModel,
  keepUnchanged,
  shownName,
  signedByKey,
} from "./card-model.js";

const card = (over: Partial<CardModel> = {}): CardModel => ({
  id: "a",
  type: "deletion",
  author: "bob",
  signature: { signed: false },
  verb: "suggests deleting",
  when: "now",
  excerpt: "word",
  deleted: false,
  decidedBy: undefined,
  seeText: false,
  proposal: undefined,
  body: undefined,
  note: undefined,
  state: "open",
  status: undefined,
  lost: undefined,
  conflicts: [],
  actions: ["accept", "reject"],
  open: true,
  replies: [],
  canReply: true,
  ...over,
});

describe("keepUnchanged (phase 10g: a card unchanged is not drawn again)", () => {
  test("an unchanged card is the very object shown before; a changed one is new", () => {
    const shown = new Map<string, CardModel>();
    const [first] = keepUnchanged(shown, [card()]);
    const [same] = keepUnchanged(shown, [card()]);
    expect(same).toBe(first);
    const [changed] = keepUnchanged(shown, [
      card({ state: "pending-accept", actions: [] }),
    ]);
    expect(changed).not.toBe(first);
    expect(changed?.state).toBe("pending-accept");
    const [proposal] = keepUnchanged(shown, [
      card({
        state: "pending-accept",
        actions: [],
        proposal: { kind: "text", text: "x" },
      }),
    ]);
    expect(proposal).not.toBe(changed);
    const [conflict] = keepUnchanged(shown, [
      card({
        state: "pending-accept",
        actions: [],
        proposal: { kind: "text", text: "x" },
        conflicts: ["b"],
      }),
    ]);
    expect(conflict).not.toBe(proposal);
    const [dated] = keepUnchanged(shown, [
      card({
        state: "pending-accept",
        actions: [],
        proposal: { kind: "text", text: "x" },
        conflicts: ["b"],
        when: "later",
      }),
    ]);
    expect(dated).not.toBe(conflict);
  });

  test("a new reply, or the reply field closing, draws the card again", () => {
    const shown = new Map<string, CardModel>();
    const reply = {
      author: "carol",
      when: "now",
      body: "why?",
      signature: { signed: false } as const,
    };
    const [first] = keepUnchanged(shown, [card({ replies: [reply] })]);
    const [same] = keepUnchanged(shown, [card({ replies: [{ ...reply }] })]);
    expect(same).toBe(first);
    const [more] = keepUnchanged(shown, [
      card({ replies: [reply, { ...reply, body: "because" }] }),
    ]);
    expect(more).not.toBe(first);
    const [closed] = keepUnchanged(shown, [
      card({
        replies: [reply, { ...reply, body: "because" }],
        canReply: false,
      }),
    ]);
    expect(closed).not.toBe(more);
  });

  test("a card gone is forgotten", () => {
    const shown = new Map<string, CardModel>();
    keepUnchanged(shown, [card(), card({ id: "b" })]);
    keepUnchanged(shown, [card({ id: "b" })]);
    expect([...shown.keys()]).toEqual(["b"]);
  });

  test("a mark that changes draws the card again (ID-17)", () => {
    const shown = new Map<string, CardModel>();
    const signed = {
      signed: true as const,
      fingerprint: new Uint8Array(32),
      short: "0000 0000 0000 0000",
      twoKeys: false,
    };
    const [first] = keepUnchanged(shown, [card()]);
    const [marked] = keepUnchanged(shown, [card({ signature: signed })]);
    expect(marked).not.toBe(first);
    const [same] = keepUnchanged(shown, [card({ signature: { ...signed } })]);
    expect(same).toBe(marked);
    const [warned] = keepUnchanged(shown, [
      card({ signature: { ...signed, twoKeys: true } }),
    ]);
    expect(warned).not.toBe(marked);
    // A third key for its name (ID-42).
    const key = (n: number) => ({
      fingerprint: String(n).repeat(64),
      short: `${n}${n}${n}${n}`,
    });
    const [two] = keepUnchanged(shown, [
      card({
        signature: { ...signed, twoKeys: true, nameKeys: [key(1), key(2)] },
      }),
    ]);
    const [three] = keepUnchanged(shown, [
      card({
        signature: {
          ...signed,
          twoKeys: true,
          nameKeys: [key(1), key(2), key(3)],
        },
      }),
    ]);
    expect(three).not.toBe(two);
  });

  test("an attestation arriving, or a revocation, draws the card again (ID-39)", () => {
    const shown = new Map<string, CardModel>();
    const signed = {
      signed: true as const,
      fingerprint: new Uint8Array(32),
      short: "0000 0000 0000 0000",
      twoKeys: false,
    };
    const attested = {
      ...signed,
      attested: {
        id: "ab".repeat(32),
        issuer: "https://idp.example",
        sub: "s",
        name: "Ada Lovelace",
        key: new Uint8Array(32),
        issuedAt: 1,
        expiresAt: 2,
      },
    };
    const [first] = keepUnchanged(shown, [card({ signature: signed })]);
    const [named] = keepUnchanged(shown, [card({ signature: attested })]);
    expect(named).not.toBe(first);
    const [revoked] = keepUnchanged(shown, [
      card({ signature: { ...attested, revokedAt: 5 } }),
    ]);
    expect(revoked).not.toBe(named);
  });
});

// ID-39: an attested object shows its attested name, never the
// pseudonym it carries; signed or not, the name it carries.
describe("the name shown", () => {
  test("the attested one, else the one carried", () => {
    const signed = {
      signed: true as const,
      fingerprint: new Uint8Array(32),
      short: "0000 0000 0000 0000",
      twoKeys: false,
    };
    expect(shownName("pseudonym", { signed: false })).toBe("pseudonym");
    expect(shownName("pseudonym", signed)).toBe("pseudonym");
    expect(
      shownName("pseudonym", {
        ...signed,
        attested: {
          id: "ab".repeat(32),
          issuer: "i",
          sub: "s",
          name: "Ada Lovelace",
          key: new Uint8Array(32),
          issuedAt: 1,
          expiresAt: 2,
        },
      }),
    ).toBe("Ada Lovelace");
  });
});

describe("signedByKey (ADR-0051 §3): what each key signed, by annotation", () => {
  test("an annotation counted once for its key, whether it signed it or a reply; unsigned ones, nothing", () => {
    const by = (n: number) => ({
      signed: true as const,
      fingerprint: new Uint8Array(32).fill(n),
      short: "",
      twoKeys: false,
    });
    const reply = (n: number) => ({
      author: "x",
      when: "",
      body: "",
      signature: by(n),
    });
    const hex = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
    const signed = signedByKey([
      card({ id: "a", signature: by(1), replies: [reply(2), reply(1)] }),
      card({ id: "b", replies: [reply(2), reply(2)] }),
      card({ id: "c" }),
    ]);
    expect(Object.fromEntries(signed)).toEqual({
      [hex(1)]: ["a"],
      [hex(2)]: ["a", "b"],
    });
  });
});
