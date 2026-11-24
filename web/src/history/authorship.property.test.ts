import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { authorRuns, personOrder } from "./authorship.js";

type TC = Parameters<Parameters<typeof hegel.test>[0]>[0];

/** Each peer types its own characters, one outside the basic plane: who
 * wrote a character is read from the character itself, never from Loro. */
const ALPHABETS: Record<string, readonly string[]> = {
  "1": ["a", "b", "😀"],
  "2": ["c", "d", "🎉"],
  "3": ["e", "f", "🌍"],
};
const writerOf = new Map(
  Object.entries(ALPHABETS).flatMap(([peer, chars]) =>
    chars.map((char) => [char, peer] as const),
  ),
);

const sync = (from: LoroDoc, to: LoroDoc) =>
  to.import(from.export({ mode: "update", from: to.oplogVersion() }));

/** The positions between two characters, never inside a pair. */
function boundaries(text: string): number[] {
  const at = [0];
  for (const char of text) at.push((at.at(-1) as number) + char.length);
  return at;
}

/** Up to three pages typing and deleting concurrently, syncing now and
 * then in any direction; not synced at the end. */
function pages(tc: TC): LoroDoc[] {
  const count = tc.draw(gs.integers({ minValue: 1, maxValue: 3 }));
  const docs = Array.from({ length: count }, (_, i) => {
    const doc = new LoroDoc();
    doc.setPeerId(BigInt(i + 1));
    return doc;
  });
  const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 25 }));
  for (let step = 0; step < steps; step++) {
    const i = tc.draw(gs.integers({ minValue: 0, maxValue: count - 1 }));
    const doc = docs[i] as LoroDoc;
    const text = doc.getText("content");
    const at = boundaries(text.toString());
    if (at.length > 1 && tc.draw(gs.booleans())) {
      const start = tc.draw(
        gs.integers({ minValue: 0, maxValue: at.length - 2 }),
      );
      const stop = tc.draw(
        gs.integers({ minValue: start + 1, maxValue: at.length - 1 }),
      );
      text.delete(
        at[start] as number,
        (at[stop] as number) - (at[start] as number),
      );
    } else {
      const where = tc.draw(gs.sampledFrom(at));
      const chars = tc.draw(
        gs.arrays(gs.sampledFrom(ALPHABETS[String(i + 1)] as string[]), {
          minSize: 1,
          maxSize: 3,
        }),
      );
      text.insert(where, chars.join(""));
    }
    doc.commit();
    if (count > 1 && tc.draw(gs.booleans())) {
      const j = tc.draw(gs.integers({ minValue: 0, maxValue: count - 1 }));
      if (j !== i) sync(doc, docs[j] as LoroDoc);
    }
  }
  return docs;
}

/** `items` in a drawn order. */
function shuffled<T>(tc: TC, items: readonly T[]): T[] {
  const left = [...items];
  const out: T[] = [];
  while (left.length > 0) {
    const i = tc.draw(gs.integers({ minValue: 0, maxValue: left.length - 1 }));
    out.push(...left.splice(i, 1));
  }
  return out;
}

/** Who wrote each UTF-16 unit of `text`, by its character. */
function expectedPeers(text: string): string[] {
  const peers: string[] = [];
  for (const char of text) {
    for (let unit = 0; unit < char.length; unit++) {
      peers.push(writerOf.get(char) as string);
    }
  }
  return peers;
}

describe("authorship", () => {
  test(
    "the stretches of any range are who typed each character, in maximal runs",
    () => hegel.test(stretches, { testCases: 400 }),
    60_000,
  );

  test(
    "the persons' order: the same on every page, a later person last",
    () => hegel.test(order, { testCases: 400 }),
    60_000,
  );
});

function stretches(tc: TC): void {
  const docs = pages(tc);
  const doc = tc.draw(gs.sampledFrom(docs));
  const text = doc.getText("content");
  const length = text.length;
  const from = tc.draw(gs.integers({ minValue: 0, maxValue: length + 1 }));
  const to = tc.draw(gs.integers({ minValue: 0, maxValue: length + 2 }));
  const runs = authorRuns(text, from, to);
  const end = Math.min(to, length);
  if (from >= end) {
    expect(runs).toEqual([]);
    return;
  }
  const expected = expectedPeers(text.toString());
  expect(runs[0]?.from).toBe(from);
  expect(runs.at(-1)?.to).toBe(end);
  runs.forEach((run, i) => {
    expect(run.to).toBeGreaterThan(run.from);
    if (i > 0) {
      expect(run.from).toBe(runs[i - 1]?.to);
      expect(run.peer).not.toBe(runs[i - 1]?.peer);
    }
    for (let at = run.from; at < run.to; at++) {
      expect(run.peer).toBe(expected[at]);
    }
  });
}

function order(tc: TC): void {
  const docs = pages(tc);
  // Any naming: two peers may share a name, one may have none.
  const names = new Map<string, string>();
  for (const peer of ["1", "2", "3", "4"]) {
    const name = tc.draw(gs.sampledFrom(["", "alice", "bob", "carol"]));
    if (name) names.set(peer, name);
  }
  // Every page receives everything, each in its own order.
  for (const to of docs) {
    for (const from of shuffled(tc, docs)) sync(from, to);
  }
  const [first] = docs as [LoroDoc];
  const order = personOrder(first, names);
  for (const doc of docs) expect(personOrder(doc, names)).toEqual(order);
  // A page that has seen everything then writes: if its name is new,
  // it comes last, and no other moves.
  const late = new LoroDoc();
  late.setPeerId(4n);
  sync(first, late);
  late.getText("content").insert(0, "z");
  late.commit();
  sync(late, first);
  const after = personOrder(first, names);
  const name = names.get("4");
  if (name === undefined || order.includes(`@${name}`)) {
    expect(after).toEqual(order);
  } else {
    expect(after).toEqual([...order, `@${name}`]);
  }
}
