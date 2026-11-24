// What a document view tells the keyring (docs/protocol/05-keyring.md,
// KR-23, KR-24; decision 7; TR2): opened, its title, refused or deleted,
// a rotation's new link kept before the rotation goes, and « keep this
// document » — on a session whose copy is in memory.
import { describe, expect, test } from "vitest";
import {
  type KeyringCredentials,
  bytesToBase64Url,
  listKeyring,
  newKeyringSecrets,
} from "../../lib/src/index.js";
import { testLink } from "../../lib/src/keyring/test-support/links.js";
import { documentKeyring } from "./hooks.js";
import type { KeyringLocal } from "./local.js";
import { KeyringSession } from "./session.js";

const KEY = bytesToBase64Url(new Uint8Array(32).fill(0xa0));
const link = (role: string, n: number) => testLink("d1", role, n);

function memoryLocal(result: "saved" | "superseded" = "saved"): KeyringLocal {
  return {
    load: async () => undefined,
    save: async () => result,
    replace: async () => {},
    claim: async () => "claimed",
    join: async () => "nothing-here",
    forget: async () => {},
    rotate: async () => "rotated" as const,
    retired: async () => [],
    clearRetired: async () => {},
    successor: async () => undefined,
    // Starting over (analysis 18p.3) is not in this test.
    startOver: async () => "taken" as const,
    startingOver: async () => false,
    clearStartOver: async () => {},
  };
}

async function session(local = memoryLocal()) {
  const credentials: KeyringCredentials = {
    keyringId: "ab".repeat(16),
    ...newKeyringSecrets(),
  };
  const adopted = await KeyringSession.adopt(
    {
      local,
      remove: async () => "deleted",
      transport: () => ({
        read: async () => "missing",
        write: async () => "missing",
      }),
      setTimer: () => () => {},
    },
    credentials,
  );
  if (!adopted) throw new Error("not adopted");
  return adopted;
}

describe("a document view and the keyring", () => {
  test("opened, created, titled: the document is kept, once", async () => {
    const s = await session();
    let now = 1000;
    const hooks = documentKeyring(() => Promise.resolve(s), "d1", {
      created: true,
      now: () => now,
    });
    await hooks.opened(link("edit", 1));
    now = 2000;
    await hooks.title("Plan");
    await hooks.title("Plan, again");
    const [entry] = s.entries();
    expect(entry).toMatchObject({
      documentId: "d1",
      role: "edit",
      title: "Plan",
      openedAt: 2000,
      createdHere: true,
      state: "ok",
    });
  });

  test("a link of another document given (pasted, phase 19): kept, and its title read without waiting", async () => {
    const s = await session();
    const hooks = documentKeyring(async () => s, "d1", { now: () => 5 });
    const other = testLink("d2", "suggest", 0);
    await hooks.given(other);
    expect(listKeyring(s.doc).map((e) => [e.documentId, e.link])).toEqual([
      ["d2", other],
    ]);
    expect(hooks.titleOf("d2")).toBeUndefined();
    // Its title, noted by another view of it: read as it is now.
    await documentKeyring(async () => s, "d2", { now: () => 6 }).title("Plan");
    expect(hooks.titleOf("d2")).toBe("Plan");
    expect(hooks.titleOf("d3")).toBeUndefined();
  });

  test("refused, revoked, deleted: noted as the codes say (KR-23)", async () => {
    const s = await session();
    const hooks = documentKeyring(() => Promise.resolve(s), "d1", {
      now: () => 5,
    });
    await hooks.opened(link("edit", 1));
    await hooks.refused(link("edit", 1), 4401);
    expect(s.entries()[0]?.state).toBe("renewed");
    await hooks.keep(link("edit", 2));
    expect(s.entries()[0]?.state).toBe("ok");
    await hooks.refused(link("edit", 2), 4410);
    expect(s.entries()[0]?.state).toBe("renewed");
    await hooks.refused(link("edit", 2), 4404);
    expect(s.entries()[0]?.state).toBe("deleted");
    // Another refusal says nothing of the link.
    const other = await session();
    const quiet = documentKeyring(() => Promise.resolve(other), "d1", {
      now: () => 5,
    });
    await quiet.opened(link("read", 1));
    await quiet.refused(link("read", 1), 4429);
    expect(other.entries()[0]?.state).toBe("ok");
  });

  test("TR2: keep resolves once the copy holds the new link, and rejects if it can't", async () => {
    const s = await session();
    const hooks = documentKeyring(() => Promise.resolve(s), "d1", {
      now: () => 5,
    });
    await hooks.keep(link("edit", 7));
    expect(s.entries()[0]?.link).toBe(link("edit", 7));
    const stale = await session(memoryLocal("superseded"));
    await expect(
      documentKeyring(() => Promise.resolve(stale), "d1", {
        now: () => 5,
      }).keep(link("edit", 8)),
    ).rejects.toThrow();
    // Without a keyring, nothing to keep: a rotation isn't held back.
    await documentKeyring(() => Promise.resolve(undefined), "d1", {
      now: () => 5,
    }).keep(link("edit", 9));
  });

  test("KR-24: not kept, the document isn't added back by opening it", async () => {
    const s = await session();
    const hooks = documentKeyring(() => Promise.resolve(s), "d1", {
      now: () => 5,
    });
    await hooks.opened(link("edit", 1));
    expect(await hooks.isKept()).toBe(true);
    await hooks.setKept(false, link("edit", 1));
    expect(listKeyring(s.doc)).toEqual([]);
    await hooks.opened(link("edit", 1));
    expect(await hooks.isKept()).toBe(false);
    await hooks.setKept(true, link("edit", 1));
    expect(await hooks.isKept()).toBe(true);
  });

  test("LA2: opened before the tab had a list, noted again in the list it gets", async () => {
    const tabList: { current?: KeyringSession } = {};
    let now = 1000;
    const hooks = documentKeyring(
      () => Promise.resolve(tabList.current),
      "d1",
      {
        created: true,
        now: () => now,
      },
    );
    await hooks.opened(link("edit", 1));
    await hooks.title("Plan");
    await hooks.keep(link("edit", 2));
    const current = await session();
    tabList.current = current;
    now = 2000;
    await hooks.again();
    const [entry] = current.entries();
    expect(entry).toMatchObject({
      documentId: "d1",
      createdHere: true,
      title: "Plan",
      link: link("edit", 2),
      openedAt: 2000,
    });
  });

  test("LA2, KR-24: a document taken out of the list isn't put back by a new one", async () => {
    const s = await session();
    const hooks = documentKeyring(() => Promise.resolve(s), "d1", {
      now: () => 5,
    });
    await hooks.opened(link("edit", 1));
    await hooks.setKept(false, link("edit", 1));
    await hooks.again();
    expect(listKeyring(s.doc)).toEqual([]);
  });

  test("LA2: nothing opened yet, nothing noted", async () => {
    const s = await session();
    const hooks = documentKeyring(() => Promise.resolve(s), "d1", {
      now: () => 5,
    });
    await hooks.again();
    expect(listKeyring(s.doc)).toEqual([]);
  });
});
