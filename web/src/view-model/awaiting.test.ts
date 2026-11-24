import { describe, expect, test } from "vitest";
import type { Attestation, Verdict } from "../../lib/src/index.js";
import {
  type Me,
  type ThreadEntry,
  awaits,
  entryOwner,
  lastEntryId,
} from "./awaiting.js";

const MINE = new Uint8Array(32).fill(1);
const OLD_MINE = new Uint8Array(32).fill(2);
const THEIRS = new Uint8Array(32).fill(3);
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const me: Me = {
  keys: new Set([hex(MINE)]),
  account: { issuer: "https://idp.example", sub: "alice" },
  pseudonym: "Alice",
};

const SIG = new Uint8Array(72);
const UNSIGNED: Verdict = { signed: false };
function signed(fingerprint: Uint8Array, attested?: Attestation): Verdict {
  return {
    signed: true,
    fingerprint,
    short: "",
    twoKeys: false,
    ...(attested && { attested }),
  };
}
function attestation(issuer: string, sub: string): Attestation {
  return {
    id: "a",
    issuer,
    sub,
    name: "Alice A.",
    key: OLD_MINE,
    issuedAt: 0,
    expiresAt: 1,
  };
}

describe("entryOwner (ADR-0050 §2)", () => {
  test("signed by one of my keys: mine, whatever the name", () => {
    expect(entryOwner({ author: "Bob", sig: SIG }, signed(MINE), me)).toBe(
      "me",
    );
  });

  test("signed by another key under my pseudonym: another's (ID-17)", () => {
    expect(entryOwner({ author: "Alice", sig: SIG }, signed(THEIRS), me)).toBe(
      "other",
    );
  });

  test("signed by an old key attested for my account: mine", () => {
    const verdict = signed(
      OLD_MINE,
      attestation("https://idp.example", "alice"),
    );
    expect(entryOwner({ author: "A.", sig: SIG }, verdict, me)).toBe("me");
  });

  test("attested for another account, or another issuer: another's", () => {
    for (const [issuer, sub] of [
      ["https://idp.example", "bob"],
      ["https://other.example", "alice"],
    ] as const) {
      const verdict = signed(OLD_MINE, attestation(issuer, sub));
      expect(entryOwner({ author: "Alice", sig: SIG }, verdict, me)).toBe(
        "other",
      );
    }
  });

  test("attested, but I'm not signed in: by the key only", () => {
    const verdict = signed(
      OLD_MINE,
      attestation("https://idp.example", "alice"),
    );
    const { account: _, ...signedOut } = me;
    expect(entryOwner({ author: "Alice", sig: SIG }, verdict, signedOut)).toBe(
      "other",
    );
  });

  test("unsigned: mine under my pseudonym only", () => {
    expect(entryOwner({ author: "Alice" }, UNSIGNED, me)).toBe("me");
    expect(entryOwner({ author: "alice" }, UNSIGNED, me)).toBe("other");
    expect(entryOwner({ author: "Bob" }, UNSIGNED, me)).toBe("other");
  });

  test("carrying a signature that didn't verify: another's, even under my pseudonym", () => {
    expect(entryOwner({ author: "Alice", sig: SIG }, UNSIGNED, me)).toBe(
      "other",
    );
  });
});

const entry = (id: string, owner: ThreadEntry["owner"]): ThreadEntry => ({
  id,
  owner,
});

describe("awaits (ADR-0050 §1, §4)", () => {
  test("another's annotation, no reply: awaits me", () => {
    expect(awaits([entry("a", "other")])).toBe(true);
  });

  test("my annotation, no reply: doesn't", () => {
    expect(awaits([entry("a", "me")])).toBe(false);
  });

  test("my annotation, then another's reply: awaits me", () => {
    expect(awaits([entry("a", "me"), entry("r1", "other")])).toBe(true);
  });

  test("another's, then my reply: doesn't; then another's again: does", () => {
    const thread = [entry("a", "other"), entry("r1", "me")];
    expect(awaits(thread)).toBe(false);
    expect(awaits([...thread, entry("r2", "other")])).toBe(true);
  });

  test("set aside at its last entry: doesn't, until a new entry", () => {
    const thread = [entry("a", "other"), entry("r1", "other")];
    expect(awaits(thread, "r1")).toBe(false);
    expect(awaits([...thread, entry("r2", "other")], "r1")).toBe(true);
  });

  test("set aside at an entry that is no longer the last (one erased, another written): awaits", () => {
    expect(awaits([entry("a", "other"), entry("r9", "other")], "r1")).toBe(
      true,
    );
  });

  test("an empty thread: nothing", () => {
    expect(awaits([])).toBe(false);
  });
});

describe("lastEntryId", () => {
  const annotation = (replies: { id?: string }[]) =>
    ({ id: "a", replies }) as unknown as Parameters<typeof lastEntryId>[0];
  test("the annotation's, its last reply's, or that reply's place", () => {
    expect(lastEntryId(annotation([]))).toBe("a");
    expect(lastEntryId(annotation([{ id: "r1" }, { id: "r2" }]))).toBe("r2");
    expect(lastEntryId(annotation([{ id: "r1" }, {}]))).toBe("@1");
  });
});
