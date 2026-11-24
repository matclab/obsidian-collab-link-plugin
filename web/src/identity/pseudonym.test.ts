import { describe, expect, test, vi } from "vitest";
import {
  authorOf,
  ensurePseudonym,
  savePseudonym,
  storedPseudonym,
} from "./pseudonym.js";

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, value),
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  };
}

describe("ensurePseudonym", () => {
  test("returns the stored pseudonym without asking, when one already exists", async () => {
    const storage = fakeStorage();
    storage.setItem("obsidian-collab:pseudonym", "alice");
    const ask = vi.fn();

    expect(await ensurePseudonym(ask, storage)).toBe("alice");
    expect(ask).not.toHaveBeenCalled();
  });

  test("asks once and stores the answer, trimmed, when none exists yet", async () => {
    const storage = fakeStorage();
    const ask = vi.fn().mockResolvedValue("  bob ");

    expect(await ensurePseudonym(ask, storage)).toBe("bob");
    expect(ask).toHaveBeenCalledTimes(1);
    expect(storage.getItem("obsidian-collab:pseudonym")).toBe("bob");
  });

  test("without an answer, anonymous", async () => {
    const storage = fakeStorage();
    expect(await ensurePseudonym(async () => null, storage)).toBe("anonymous");
    expect(await ensurePseudonym(async () => "   ", fakeStorage())).toBe(
      "anonymous",
    );
  });
});

describe("storedPseudonym", () => {
  test("the one kept in this browser, or none: nothing is asked", () => {
    const storage = fakeStorage();
    expect(storedPseudonym(storage)).toBeUndefined();
    storage.setItem("obsidian-collab:pseudonym", "carol");
    expect(storedPseudonym(storage)).toBe("carol");
  });
});

// Decision 9 of phase 7: changed from the page, for this browser.
describe("savePseudonym", () => {
  test("stores the trimmed name, and ensurePseudonym returns it then", () => {
    const storage = fakeStorage();
    storage.setItem("obsidian-collab:pseudonym", "alice");

    expect(savePseudonym("  Alice B.  ", storage)).toBe("Alice B.");
    expect(storedPseudonym(storage)).toBe("Alice B.");
  });

  test("refuses an empty name or one of more than 200 characters", () => {
    const storage = fakeStorage();
    storage.setItem("obsidian-collab:pseudonym", "alice");

    for (const name of ["", "   ", "x".repeat(201)]) {
      expect(savePseudonym(name, storage)).toBeUndefined();
    }
    expect(savePseudonym("x".repeat(200), storage)).toBe("x".repeat(200));
    savePseudonym("", storage);
    expect(storage.getItem("obsidian-collab:pseudonym")).toBe("x".repeat(200));
  });
});

describe("authorOf", () => {
  test("signed in: the identity's name, whatever pseudonym was chosen", () => {
    expect(authorOf("MCL", "Ada Lovelace")).toEqual({
      name: "Ada Lovelace",
      fromIdentity: true,
    });
    expect(authorOf("MCL", "  Ada  ").name).toBe("Ada");
    expect(authorOf("MCL", "x".repeat(300)).name).toBe("x".repeat(200));
  });

  test("signed out, or an identity without a name: the pseudonym", () => {
    expect(authorOf("MCL", undefined)).toEqual({
      name: "MCL",
      fromIdentity: false,
    });
    expect(authorOf("MCL", "   ")).toEqual({
      name: "MCL",
      fromIdentity: false,
    });
  });
});
