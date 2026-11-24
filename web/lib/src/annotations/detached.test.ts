import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import {
  MAX_SUGGESTION_BYTES,
  SuggestionTooLarge,
  changeIdSpans,
  checkDetachedChange,
  createDetachedChange,
  importedOnly,
  onOneLine,
  oneInsertion,
  previewDetachedChange,
  suggestionPeer,
} from "./detached.js";

const BASE = "the cat sat on the mat";

function doc(peer: number, text?: string): LoroDoc {
  const d = new LoroDoc();
  d.setPeerId(peer);
  if (text !== undefined) {
    d.getText("content").insert(0, text);
    d.commit();
  }
  return d;
}

function copy(from: LoroDoc, peer: number): LoroDoc {
  const d = doc(peer);
  d.import(from.export({ mode: "snapshot" }));
  return d;
}

const text = (d: LoroDoc) => d.getText("content").toString();

/** What a malicious reviewer can build: any edit on a fork. */
function forge(
  from: LoroDoc,
  peer: bigint | number,
  edit: (d: LoroDoc) => void,
): Uint8Array {
  const fork = from.fork();
  fork.setPeerId(peer);
  const before = fork.oplogVersion();
  edit(fork);
  fork.commit();
  return fork.export({ mode: "update", from: before });
}

describe("suggestionPeer", () => {
  test("is derived from the annotation id, the same everywhere", () => {
    expect(suggestionPeer("a1")).toBe(suggestionPeer("a1"));
    expect(suggestionPeer("a1")).not.toBe(suggestionPeer("a2"));
    expect(typeof suggestionPeer("a1")).toBe("bigint");
  });
});

describe("createDetachedChange", () => {
  // docs/protocol/04-obligations.md, O-18: the change must fit in an
  // annotation's frame, and, in base64, in the proposal that accepts it.
  test("refuses a text whose change wouldn't fit in a proposal, counted in UTF-8", () => {
    const reviewer = doc(2, BASE);
    const half = Math.floor(MAX_SUGGESTION_BYTES / 2);

    expect(() =>
      createDetachedChange(
        reviewer,
        "a1",
        4,
        "x".repeat(MAX_SUGGESTION_BYTES + 1),
      ),
    ).toThrow(SuggestionTooLarge);
    expect(() =>
      createDetachedChange(reviewer, "a1", 4, "é".repeat(half + 1)),
    ).toThrow(SuggestionTooLarge);
    expect(MAX_SUGGESTION_BYTES * (4 / 3) + 4096).toBeLessThan(8 * 1024 * 1024);
  });

  test("leaves the reviewer's doc untouched: nothing to publish on content", () => {
    const reviewer = doc(2, BASE);
    const version = reviewer.oplogVersion();
    createDetachedChange(reviewer, "a1", 4, "big ");
    expect(text(reviewer)).toBe(BASE);
    expect(reviewer.oplogVersion().compare(version)).toBe(0);
  });

  test("exports one change of the derived peer, which inserts the text", () => {
    const editor = doc(1, BASE);
    const change = createDetachedChange(copy(editor, 2), "a1", 4, "big ");
    expect(changeIdSpans(change)).toEqual([
      { peer: suggestionPeer("a1").toString(), start: 0, end: 4 },
    ]);
    editor.import(change);
    expect(text(editor)).toBe("the big cat sat on the mat");
  });

  test("refuses an empty text", () => {
    expect(() => createDetachedChange(doc(2, BASE), "a1", 4, "")).toThrow();
  });
});

describe("checkDetachedChange", () => {
  test("an honest change is valid, with its text, and checking imports nothing", () => {
    const editor = doc(1, BASE);
    const change = createDetachedChange(copy(editor, 2), "a1", 4, "big ");
    expect(checkDetachedChange(editor, "a1", change)).toEqual({
      kind: "valid",
      text: "big ",
    });
    expect(text(editor)).toBe(BASE);
  });

  test("lands where the reviewer put it after concurrent edits", () => {
    const editor = doc(1, BASE);
    const change = createDetachedChange(copy(editor, 2), "a1", 4, "big ");
    editor.getText("content").insert(0, "Yesterday, ");
    editor.commit();
    expect(checkDetachedChange(editor, "a1", change).kind).toBe("valid");
    editor.import(change);
    expect(text(editor)).toBe("Yesterday, the big cat sat on the mat");
  });

  test("is pending while its dependencies are missing, then valid", () => {
    const editor = doc(1, BASE);
    const reviewer = copy(editor, 2);
    reviewer.getText("content").insert(0, "# ");
    reviewer.commit();
    const late = copy(editor, 3);
    const change = createDetachedChange(reviewer, "a1", 6, "big ");
    expect(checkDetachedChange(late, "a1", change)).toEqual({
      kind: "pending",
    });
    expect(text(late)).toBe(BASE);
    late.import(reviewer.export({ mode: "update", from: late.oplogVersion() }));
    expect(checkDetachedChange(late, "a1", change)).toEqual({
      kind: "valid",
      text: "big ",
    });
  });

  test("is present once imported, however it arrived", () => {
    const e1 = doc(1, BASE);
    const e2 = copy(e1, 3);
    const change = createDetachedChange(copy(e1, 2), "a1", 4, "big ");
    e1.import(change);
    e2.import(e1.export({ mode: "update", from: e2.oplogVersion() }));
    expect(checkDetachedChange(e1, "a1", change)).toEqual({ kind: "present" });
    expect(checkDetachedChange(e2, "a1", change)).toEqual({ kind: "present" });
  });

  test("stays importable from a full snapshot taken after its creation (ADR-0017)", () => {
    const editor = doc(1, BASE);
    const change = createDetachedChange(copy(editor, 2), "a1", 4, "big ");
    editor.getText("content").insert(BASE.length, " again");
    editor.commit();
    const newcomer = copy(editor, 4);
    expect(checkDetachedChange(newcomer, "a1", change).kind).toBe("valid");
  });

  const editor = doc(1, BASE);
  const p = suggestionPeer("a1");
  const forged: Record<string, Uint8Array> = {
    "an insertion hiding a deletion": forge(editor, p, (d) => {
      d.getText("content").insert(4, "big ");
      d.getText("content").delete(12, 10);
    }),
    "a deletion alone": forge(editor, p, (d) =>
      d.getText("content").delete(0, 4),
    ),
    "a second container": forge(editor, p, (d) => {
      d.getText("content").insert(4, "big ");
      d.getMap("other").set("x", 1);
    }),
    "a second text": forge(editor, p, (d) => {
      d.getText("content").insert(4, "big ");
      d.getText("content2").insert(0, "x");
    }),
    "two insertions": forge(editor, p, (d) => {
      d.getText("content").insert(4, "big ");
      d.getText("content").insert(0, "X");
    }),
    "a mark": forge(editor, p, (d) => {
      d.getText("content").insert(4, "big ");
      d.configTextStyle({ bold: { expand: "after" } });
      d.getText("content").mark({ start: 0, end: 3 }, "bold", true);
    }),
    "an editor's peer": forge(editor, 1, (d) =>
      d.getText("content").insert(4, "big "),
    ),
    "a peer not derived from the annotation": forge(editor, 999n, (d) =>
      d.getText("content").insert(4, "big "),
    ),
    "a snapshot": (() => {
      const f = editor.fork();
      f.setPeerId(p);
      f.getText("content").delete(0, BASE.length);
      f.commit();
      return f.export({ mode: "snapshot" });
    })(),
    "arbitrary bytes": new Uint8Array([1, 2, 3, 4, 5]),
    nothing: new Uint8Array(),
  };

  test.each(Object.entries(forged))(
    "%s is invalid, and nothing is imported",
    (_, change) => {
      expect(checkDetachedChange(editor, "a1", change).kind).toBe("invalid");
      expect(text(editor)).toBe(BASE);
    },
  );

  test("a change with a hidden deletion is invalid for every editor, whatever it already deleted", () => {
    // A diff on the editor's state would miss the deletion of text that
    // editor already deleted (choice/loro T8, scenario 11).
    const e1 = doc(1, BASE);
    const e2 = copy(e1, 3);
    const change = forge(e1, suggestionPeer("a1"), (d) => {
      d.getText("content").insert(4, "big ");
      d.getText("content").delete(BASE.length + 4 - 3, 3); // "mat"
    });
    e1.getText("content").delete(BASE.length - 3, 3);
    e1.commit();
    expect(checkDetachedChange(e1, "a1", change).kind).toBe("invalid");
    expect(checkDetachedChange(e2, "a1", change).kind).toBe("invalid");
  });
});

describe("changeIdSpans", () => {
  test("reads the op ids a change carries, without importing it", () => {
    const change = forge(doc(1, BASE), 42n, (d) =>
      d.getText("content").insert(0, "hello"),
    );
    expect(changeIdSpans(change)).toEqual([{ peer: "42", start: 0, end: 5 }]);
  });

  test("is undefined for bytes that are not a Loro update", () => {
    expect(changeIdSpans(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });
});

describe("previewDetachedChange", () => {
  test("a valid change, with its text and where it would land now", () => {
    const editor = doc(1, BASE);
    const change = createDetachedChange(copy(editor, 2), "a1", 4, "big ");
    editor.getText("content").insert(0, ">> ");
    editor.commit();
    expect(previewDetachedChange(editor, "a1", change)).toEqual({
      kind: "valid",
      text: "big ",
      at: 7,
    });
    expect(text(editor)).toBe(`>> ${BASE}`);
  });

  test("lands after text typed concurrently at the same spot (choice/loro T8, scenario 12)", () => {
    const editor = doc(1, BASE);
    const change = createDetachedChange(copy(editor, 2), "a1", 4, "big ");
    editor.getText("content").insert(4, "fat ");
    editor.commit();
    const preview = previewDetachedChange(editor, "a1", change);
    expect(preview).toEqual({ kind: "valid", text: "big ", at: 8 });
    editor.import(change);
    expect(text(editor)).toBe("the fat big cat sat on the mat");
  });

  test("says the same as the check otherwise", () => {
    const editor = doc(1, BASE);
    expect(
      previewDetachedChange(editor, "a1", new Uint8Array([1, 2])).kind,
    ).toBe("invalid");
  });
});

describe("a change in several pieces (security review of D-17, rule 3)", () => {
  /** The pieces of a reviewer's change: the first on the text as it was
   * at `old`, the next ones after `later` was imported too, when asked. */
  function inPieces(
    owner: LoroDoc,
    old: ReturnType<LoroDoc["frontiers"]>,
    pieces: { at: number; text: string; after?: Uint8Array }[],
  ): Uint8Array {
    const fork = owner.forkAt(old);
    // Only the reviewer's operations: from the owner's version.
    const before = owner.oplogVersion();
    for (const piece of pieces) {
      if (piece.after) fork.import(piece.after);
      fork.setPeerId(suggestionPeer("a1"));
      fork.getText("content").insert(piece.at, piece.text);
      fork.commit();
    }
    const change = fork.export({ mode: "update", from: before });
    fork.free();
    return change;
  }

  test("pieces whose positions look end to end but were read on two states of the text: invalid", () => {
    // Found by the security review of 7293a3f: valid "XY" before.
    const owner = doc(1, "Hello world.");
    const old = owner.frontiers();
    const from = owner.oplogVersion();
    owner.getText("content").insert(0, "ABCDEFGHIJ ");
    owner.commit();
    const later = owner.export({ mode: "update", from });
    // "X" at 5 of "Hello world.", "Y" at 6 once the owner's text is in:
    // in the JSON, 5 then 6; imported, "Y" lands in the owner's text.
    const change = inPieces(owner, old, [
      { at: 5, text: "X" },
      { at: 6, text: "Y", after: later },
    ]);
    const landed = copy(owner, 9);
    landed.import(change);
    expect(text(landed)).toBe("ABCDEFYGHIJ HelloX world.");
    expect(checkDetachedChange(owner, "a1", change).kind).toBe("invalid");
  });

  test("pieces each after the last, each on the one before: still one insertion", () => {
    const owner = doc(1, "Hello world.");
    const change = inPieces(owner, owner.frontiers(), [
      { at: 5, text: "," },
      { at: 6, text: " dear" },
    ]);
    expect(checkDetachedChange(owner, "a1", change)).toEqual({
      kind: "valid",
      text: ", dear",
    });
  });
});

describe("importedOnly (security review of d8dd3cb)", () => {
  const vv = (entries: [string, number][]) => new Map(entries);

  test("an import that advanced the annotation's peer, up to the change's end, and nothing else", () => {
    const before = vv([["1", 12]]);
    expect(
      importedOnly(
        before,
        vv([
          ["1", 12],
          ["7", 3],
        ]),
        "7",
        3,
      ),
    ).toBe(true);
  });

  test("an import that advanced another peer too, or the peer short of or past its end: refused", () => {
    const before = vv([["1", 12]]);
    // Operations of another peer, which a header naming only the
    // annotation's peer would have hidden.
    expect(
      importedOnly(
        before,
        vv([
          ["1", 13],
          ["7", 3],
        ]),
        "7",
        3,
      ),
    ).toBe(false);
    expect(
      importedOnly(
        before,
        vv([
          ["1", 12],
          ["7", 3],
          ["9", 1],
        ]),
        "7",
        3,
      ),
    ).toBe(false);
    expect(
      importedOnly(
        before,
        vv([
          ["1", 12],
          ["7", 2],
        ]),
        "7",
        3,
      ),
    ).toBe(false);
    expect(
      importedOnly(
        before,
        vv([
          ["1", 12],
          ["7", 4],
        ]),
        "7",
        3,
      ),
    ).toBe(false);
  });
});

describe("onOneLine", () => {
  test("each change after the first on the one before it of the peer, and on nothing else", () => {
    // The peer is at index 0 of the JSON's peer table; the first change
    // may depend on anything.
    expect(
      onOneLine(
        [
          { id: "0@0", deps: ["11@1"] },
          { id: "1@0", deps: ["0@0"] },
          { id: "4@0", deps: ["3@0"] },
        ],
        0,
      ),
    ).toBe(true);
    // Also on another peer's operation, or not on the one just before.
    expect(
      onOneLine(
        [
          { id: "0@0", deps: ["11@1"] },
          { id: "1@0", deps: ["0@0", "22@1"] },
        ],
        0,
      ),
    ).toBe(false);
    expect(
      onOneLine(
        [
          { id: "0@0", deps: ["11@1"] },
          { id: "1@0", deps: ["22@1", "0@0"] },
        ],
        0,
      ),
    ).toBe(false);
    expect(
      onOneLine(
        [
          { id: "0@0", deps: ["11@1"] },
          { id: "1@0", deps: ["22@1"] },
        ],
        0,
      ),
    ).toBe(false);
  });
});

describe("oneInsertion", () => {
  const insert = (pos: number, text: string) => ({
    container: "cid:root-content:Text",
    content: { type: "insert", pos, text },
  });

  test("the operations of one insertion, however Loro splits them: the same text", () => {
    // Read back from the same change, Loro gave one operation in one
    // editor's doc and two in another's (found by Hegel): one verdict.
    expect(oneInsertion([insert(0, "00")])).toEqual({ text: "00" });
    expect(oneInsertion([insert(0, "0"), insert(1, "0")])).toEqual({
      text: "00",
    });
    expect(
      oneInsertion([insert(3, "ab"), insert(5, "é"), insert(6, "cd")]),
    ).toEqual({ text: "abécd" });
    // Positions in code points, as Loro's JSON gives them.
    expect(oneInsertion([insert(0, "😀"), insert(1, "x")])).toEqual({
      text: "😀x",
    });
  });

  test("anything but one insertion, each piece right after the last: a reason", () => {
    expect(oneInsertion([])).toEqual({ reason: "0 operations" });
    // Before the last piece, or apart from it: two insertions.
    expect(oneInsertion([insert(1, "a"), insert(1, "b")])).toEqual({
      reason: "2 operations",
    });
    expect(oneInsertion([insert(0, "a"), insert(3, "b")])).toEqual({
      reason: "2 operations",
    });
    expect(
      oneInsertion([
        insert(0, "a"),
        {
          container: "cid:root-other:Text",
          content: { type: "insert", pos: 1, text: "b" },
        },
      ]),
    ).toEqual({ reason: "container cid:root-other:Text" });
    expect(
      oneInsertion([
        {
          container: "cid:root-content:Text",
          content: { type: "delete", pos: 0, len: 1 },
        },
      ]),
    ).toEqual({ reason: "operation delete" });
    expect(oneInsertion([insert(0, "")])).toEqual({
      reason: "empty insertion",
    });
  });
});
