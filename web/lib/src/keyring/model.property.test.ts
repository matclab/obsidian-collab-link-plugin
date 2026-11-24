// The keyring's model (docs/protocol/05-keyring.md §5.7, §5.8;
// docs/phase-18-trousseau-identite.md, TR1, TR4):
// - TR1: devices act on their own copies and exchange them in any order;
//   once each has every other's operations, all list the same, whatever the
//   order, and every document added and not removed since is listed;
// - TR4: a link refused on one device and its replacement written on
//   another, concurrently, merge into a document that is ok, with the new
//   link;
// - the decoder: arbitrary bytes, and keyrings of hostile values, never
//   throw, and list only well-formed entries.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { bytesToBase64Url } from "../crypto/role-secrets.js";
import {
  excludeDocument,
  listKeyring,
  newKeyringDoc,
  noteDeleted,
  noteOpened,
  noteRefused,
  readKeyringPlaintext,
  rememberLink,
  removeDocument,
} from "./model.js";
import { testLink } from "./test-support/links.js";

type TC = Parameters<Parameters<typeof hegel.test>[0]>[0];

const DOCS = ["d1", "d2", "d3", "d4"];
const ROLES = ["read", "suggest", "edit"] as const;
const KEY = bytesToBase64Url(new Uint8Array(32).fill(0xa0));

const link = (doc: string, role: string, generation: number) =>
  testLink(doc, role, generation);

/** `items` in an order the test draws. */
function shuffled<T>(tc: TC, items: T[]): T[] {
  const left = [...items];
  const out: T[] = [];
  while (left.length > 0) {
    const i = tc.draw(gs.integers({ minValue: 0, maxValue: left.length - 1 }));
    out.push(...left.splice(i, 1));
  }
  return out;
}

/** A clock: each write later than the one before. */
let clock = 0;
const tick = () => ++clock;

function exchange(from: LoroDoc, to: LoroDoc) {
  to.import(from.export({ mode: "update", from: to.oplogVersion() }));
}

describe("the keyring's model", () => {
  test(
    "TR1: copies exchanged in any order list the same, and lose nothing added",
    { timeout: 120_000 },
    () =>
      hegel.test((tc: TC) => {
        const devices = tc.draw(gs.integers({ minValue: 2, maxValue: 4 }));
        const copies = Array.from({ length: devices }, () => newKeyringDoc());
        // Per document: added and not removed since, as some device knows.
        const added = new Set<string>();
        // Documents some device removed, at some point.
        const removed = new Set<string>();
        const steps = tc.draw(gs.integers({ minValue: 0, maxValue: 30 }));
        for (let i = 0; i < steps; i++) {
          const d = tc.draw(
            gs.integers({ minValue: 0, maxValue: devices - 1 }),
          );
          const doc = tc.draw(gs.sampledFrom(DOCS));
          const copy = copies[d] as LoroDoc;
          switch (tc.draw(gs.integers({ minValue: 0, maxValue: 6 }))) {
            case 0:
            case 1: {
              const role = tc.draw(gs.sampledFrom([...ROLES]));
              const g = tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
              if (
                rememberLink(copy, link(doc, role, g), {
                  explicit: true,
                  at: tick(),
                })
              ) {
                added.add(doc);
              }
              break;
            }
            case 2:
              noteOpened(
                copy,
                doc,
                1000 + i,
                tc.draw(gs.sampledFrom(["A", "B"])),
              );
              break;
            case 3: {
              const role = tc.draw(gs.sampledFrom([...ROLES]));
              const g = tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
              noteRefused(copy, link(doc, role, g));
              break;
            }
            case 4:
              noteDeleted(copy, doc, 2000 + i);
              break;
            case 5:
              // A removal decides only for what it has seen: it is checked
              // below on the copies, not on `added`.
              removeDocument(copy, doc);
              removed.add(doc);
              break;
            default: {
              const other = tc.draw(
                gs.integers({ minValue: 0, maxValue: devices - 1 }),
              );
              exchange(copies[other] as LoroDoc, copy);
            }
          }
        }
        // Everyone's operations reach everyone, in an order drawn per device.
        const finals = copies.map((copy, d) => {
          const order = shuffled(tc, [...copies.keys()]);
          const merged = new LoroDoc();
          merged.import(copy.export({ mode: "snapshot" }));
          for (const other of order)
            if (other !== d) exchange(copies[other] as LoroDoc, merged);
          return merged;
        });
        const listed = finals.map((f) => JSON.stringify(listKeyring(f)));
        for (const l of listed) expect(l).toBe(listed[0]);
        // Nothing added is missing, unless a removal merged after it.
        const present = new Set(
          listKeyring(finals[0] as LoroDoc).map((e) => e.documentId),
        );
        for (const doc of added) {
          if (!present.has(doc)) expect(removed.has(doc), doc).toBe(true);
        }
      }),
  );

  test("TR1: without removal, every document added is listed", () =>
    hegel.test((tc: TC) => {
      const a = newKeyringDoc();
      const b = newKeyringDoc();
      const added = new Set<string>();
      for (
        let i = tc.draw(gs.integers({ minValue: 1, maxValue: 20 }));
        i > 0;
        i--
      ) {
        const copy = tc.draw(gs.booleans()) ? a : b;
        const doc = tc.draw(gs.sampledFrom(DOCS));
        const role = tc.draw(gs.sampledFrom([...ROLES]));
        rememberLink(
          copy,
          link(doc, role, tc.draw(gs.integers({ minValue: 0, maxValue: 3 }))),
          { explicit: true, at: tick() },
        );
        added.add(doc);
        if (tc.draw(gs.booleans())) noteOpened(copy, doc, i);
        if (tc.draw(gs.integers({ minValue: 0, maxValue: 4 })) === 0)
          exchange(a, b);
      }
      exchange(a, b);
      exchange(b, a);
      expect(new Set(listKeyring(a).map((e) => e.documentId))).toEqual(added);
      expect(JSON.stringify(listKeyring(a))).toBe(
        JSON.stringify(listKeyring(b)),
      );
    }));

  test("TR4: a refusal on one device and the new link on another merge into ok, with the new link", () =>
    hegel.test((tc: TC) => {
      const role = tc.draw(gs.sampledFrom([...ROLES]));
      const old = link("d1", role, 0);
      const renewed = link("d1", tc.draw(gs.sampledFrom([...ROLES])), 1);
      const a = newKeyringDoc();
      rememberLink(a, old, { at: tick() });
      const b = newKeyringDoc();
      exchange(a, b);
      // Concurrently: A sees the old link refused, B is given the new one.
      noteRefused(a, old);
      rememberLink(b, renewed, { explicit: true, at: tick() });
      const [first, second] = tc.draw(gs.booleans()) ? [a, b] : [b, a];
      exchange(first, second);
      exchange(second, first);
      for (const copy of [a, b]) {
        const entry = listKeyring(copy)[0];
        if (!entry) throw new Error("listed nothing");
        expect(entry.state).toBe("ok");
        expect(entry.link).toBe(renewed);
      }
    }));

  // Found by the page's scenario (phase 18d): with one link per role, the
  // older of two concurrent writes could win, by Loro's order.
  test("KR-20, KR-22: concurrent links of one document both stay; the newest accepted is current", () => {
    const a = newKeyringDoc();
    const b = newKeyringDoc();
    rememberLink(a, link("d1", "edit", 0), { at: 10 });
    rememberLink(b, link("d1", "edit", 1), { at: 20 });
    exchange(a, b);
    exchange(b, a);
    for (const copy of [a, b]) {
      expect(copy.getMap("links").size).toBe(2);
      expect(listKeyring(copy)[0]?.link).toBe(link("d1", "edit", 1));
    }
  });

  test("KR-23, TR2: a rotation never received leaves the previous link current, once the new one is refused", () => {
    const k = newKeyringDoc();
    rememberLink(k, link("d1", "edit", 0), { at: 10 });
    // Kept before the rotation is sent; the tab dies before sending it.
    rememberLink(k, link("d1", "edit", 1), { at: 20 });
    expect(listKeyring(k)[0]?.link).toBe(link("d1", "edit", 1));
    noteRefused(k, link("d1", "edit", 1));
    expect(listKeyring(k)[0]).toMatchObject({
      state: "ok",
      link: link("d1", "edit", 0),
    });
  });

  test("KR-24: an excluded document isn't added back, unless asked", () => {
    const k = newKeyringDoc();
    excludeDocument(k, "d1", 5);
    expect(rememberLink(k, link("d1", "edit", 0), { at: tick() })).toBe(false);
    expect(listKeyring(k)).toEqual([]);
    expect(
      rememberLink(k, link("d1", "edit", 0), { explicit: true, at: tick() }),
    ).toBe(true);
    expect(listKeyring(k).map((e) => [e.documentId, e.excluded])).toEqual([
      ["d1", false],
    ]);
  });

  test("KR-26: arbitrary bytes are no keyring, and never throw", () =>
    hegel.test((tc: TC) => {
      const bytes = tc.draw(gs.binary({ minSize: 0, maxSize: 256 }));
      const doc = readKeyringPlaintext(bytes);
      if (doc) listKeyring(doc);
    }));

  test("KR-21: a keyring of hostile values lists only well-formed documents", () =>
    hegel.test((tc: TC) => {
      const doc = new LoroDoc();
      const value = () =>
        tc.draw(
          gs.sampledFrom<unknown>([
            null,
            true,
            false,
            0,
            -1,
            1.5,
            Number.MAX_SAFE_INTEGER,
            "",
            "d1",
            "not a link",
            link("d1", "edit", 0),
            link("d2", "read", 1),
            "https://collab.example.org/?doc=d1#k=x&r=edit.y",
            new Uint8Array([1, 2]),
            [1, "a"],
            { a: 1 },
          ]),
        );
      const roots = [
        "read",
        "suggest",
        "edit",
        "title",
        "opened",
        "created",
        "deleted",
        "excluded",
        "failed",
        "meta",
        "other",
      ];
      for (
        let i = tc.draw(gs.integers({ minValue: 0, maxValue: 25 }));
        i > 0;
        i--
      ) {
        const root = tc.draw(gs.sampledFrom(roots));
        const key = tc.draw(
          gs.sampledFrom([
            ...DOCS,
            "",
            bytesToBase64Url(new Uint8Array(32).fill(0x11)),
          ]),
        );
        // biome-ignore lint/suspicious/noExplicitAny: hostile values of any type.
        doc.getMap(root).set(key, value() as any);
      }
      doc.commit();
      const read = readKeyringPlaintext(doc.export({ mode: "snapshot" }));
      expect(read).not.toBeNull();
      for (const entry of listKeyring(read as LoroDoc)) {
        const url = new URL(entry.link);
        expect(url.searchParams.get("doc")).toBe(entry.documentId);
        expect(["ok", "renewed", "deleted"]).toContain(entry.state);
        expect(entry.title === null || typeof entry.title === "string").toBe(
          true,
        );
        expect(
          entry.openedAt === null || Number.isSafeInteger(entry.openedAt),
        ).toBe(true);
      }
    }));
});
