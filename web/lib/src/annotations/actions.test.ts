import { LoroDoc, type LoroMap } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { counter, resetCounters } from "../perf/index.js";
import {
  applyDecisionEffects,
  suggestAddition,
  watchDecisionEffects,
} from "./actions.js";
import { AnnotationIndex } from "./annotation-index.js";
import { type Decision, DecisionLog, encodeProposal } from "./decisions.js";
import { createDetachedChange } from "./detached.js";
import {
  createAnnotation,
  listAnnotations,
  resolveAnnotation,
  tryCreateAnnotation,
} from "./model.js";

function setUp(text = "hello world") {
  const contentDoc = new LoroDoc();
  contentDoc.getText("content").insert(0, text);
  contentDoc.commit();
  const annotationsDoc = new LoroDoc();
  return { contentDoc, annotationsDoc };
}

let nextSeq = 1;
/** A log in which each (annotationId, decision) was confirmed in order;
 * an acceptance carries `change` when given (what the panel copies from
 * the annotation, ADR-0018). */
function confirmed(
  ...decisions: [string, Decision, Uint8Array?][]
): DecisionLog {
  const log = new DecisionLog();
  log.add(
    decisions.map(([annotationId, decision, change], i) => ({
      seq: nextSeq++,
      record: encodeProposal({
        proposalId: `proposal-${i}`,
        annotationId,
        decision,
        author: "bob",
        ...(change && { change }),
      }),
    })),
  );
  return log;
}

/** The change an annotation carries, as the panel copies it on accept. */
function changeOf(
  contentDoc: LoroDoc,
  annotationsDoc: LoroDoc,
  id: string,
): Uint8Array {
  const change = resolveAnnotation(contentDoc, annotationsDoc, id)?.change;
  if (!change) throw new Error(`no change on ${id}`);
  return change;
}

const text = (doc: LoroDoc) => doc.getText("content").toString();
const statusOf = (contentDoc: LoroDoc, annotationsDoc: LoroDoc) =>
  listAnnotations(contentDoc, annotationsDoc)[0]?.status;

function substitution(contentDoc: LoroDoc, annotationsDoc: LoroDoc): string {
  const result = tryCreateAnnotation(contentDoc, annotationsDoc, {
    type: "substitution",
    start: 0,
    end: 5,
    author: "alice",
    replacement: "bye",
  });
  if (!result.ok) throw new Error("unexpected conflict");
  return result.id;
}

describe("creating a substitution (ADR-0018)", () => {
  test("writes nothing to content: the replacement is a detached change after the old text", () => {
    const { contentDoc, annotationsDoc } = setUp();
    const version = contentDoc.oplogVersion();
    const id = substitution(contentDoc, annotationsDoc);

    expect(text(contentDoc)).toBe("hello world");
    expect(contentDoc.oplogVersion().compare(version)).toBe(0);
    expect(listAnnotations(contentDoc, annotationsDoc)[0]).toMatchObject({
      type: "substitution",
      status: "open",
      range: { start: 0, end: 5 },
    });
    const probe = new LoroDoc();
    probe.import(contentDoc.export({ mode: "snapshot" }));
    probe.import(changeOf(contentDoc, annotationsDoc, id));
    expect(text(probe)).toBe("hellobye world");
  });
});

describe("applyDecisionEffects", () => {
  test.each([
    ["accept", "hello ", "accepted"],
    ["reject", "hello world", "rejected"],
  ] as const)(
    "a deletion %sed: text %j, status %s",
    (decision, expected, status) => {
      const { contentDoc, annotationsDoc } = setUp();
      const id = createAnnotation(contentDoc, annotationsDoc, {
        type: "deletion",
        start: 6,
        end: 11,
        author: "alice",
      });

      applyDecisionEffects(
        contentDoc,
        annotationsDoc,
        confirmed([id, decision]),
      );

      expect(text(contentDoc)).toBe(expected);
      expect(statusOf(contentDoc, annotationsDoc)).toBe(status);
    },
  );

  test("an accepted addition imports its change", () => {
    const { contentDoc, annotationsDoc } = setUp();
    const id = suggestAddition(contentDoc, annotationsDoc, {
      at: 5,
      text: " dear",
      author: "alice",
    });
    const change = changeOf(contentDoc, annotationsDoc, id);

    applyDecisionEffects(
      contentDoc,
      annotationsDoc,
      confirmed([id, "accept", change]),
    );

    expect(text(contentDoc)).toBe("hello dear world");
    expect(statusOf(contentDoc, annotationsDoc)).toBe("accepted");
  });

  test("a rejected addition changes nothing: its text was never inserted", () => {
    const { contentDoc, annotationsDoc } = setUp();
    const id = suggestAddition(contentDoc, annotationsDoc, {
      at: 5,
      text: " dear",
      author: "alice",
    });

    applyDecisionEffects(contentDoc, annotationsDoc, confirmed([id, "reject"]));

    expect(text(contentDoc)).toBe("hello world");
    expect(statusOf(contentDoc, annotationsDoc)).toBe("rejected");
  });

  test("an accepted substitution removes the old text and imports the replacement", () => {
    const { contentDoc, annotationsDoc } = setUp();
    const id = substitution(contentDoc, annotationsDoc);
    const change = changeOf(contentDoc, annotationsDoc, id);

    applyDecisionEffects(
      contentDoc,
      annotationsDoc,
      confirmed([id, "accept", change]),
    );

    expect(text(contentDoc)).toBe("bye world");
    expect(statusOf(contentDoc, annotationsDoc)).toBe("accepted");
  });

  test("a rejected substitution changes nothing", () => {
    const { contentDoc, annotationsDoc } = setUp();
    const id = substitution(contentDoc, annotationsDoc);

    applyDecisionEffects(contentDoc, annotationsDoc, confirmed([id, "reject"]));

    expect(text(contentDoc)).toBe("hello world");
    expect(statusOf(contentDoc, annotationsDoc)).toBe("rejected");
  });

  test("the change imported is the proposal's, even if the annotation was rewritten since", () => {
    const { contentDoc, annotationsDoc } = setUp();
    const id = suggestAddition(contentDoc, annotationsDoc, {
      at: 5,
      text: " dear",
      author: "alice",
    });
    const accepted = changeOf(contentDoc, annotationsDoc, id);
    // The reviewer rewrites their annotation's change after the click.
    (annotationsDoc.getMap("annotations").get(id) as LoroMap).set(
      "change",
      createDetachedChange(contentDoc, id, 5, " evil"),
    );
    annotationsDoc.commit();

    applyDecisionEffects(
      contentDoc,
      annotationsDoc,
      confirmed([id, "accept", accepted]),
    );

    expect(text(contentDoc)).toBe("hello dear world");
  });

  test.each([
    ["without a change", undefined],
    ["with an invalid change", new Uint8Array([1, 2, 3])],
  ] as const)(
    "an addition accepted %s is accepted with no effect",
    (_, change) => {
      const { contentDoc, annotationsDoc } = setUp();
      const id = suggestAddition(contentDoc, annotationsDoc, {
        at: 5,
        text: " dear",
        author: "alice",
      });

      applyDecisionEffects(
        contentDoc,
        annotationsDoc,
        confirmed([id, "accept", ...(change ? [change] : [])] as [
          string,
          Decision,
          Uint8Array?,
        ]),
      );

      expect(text(contentDoc)).toBe("hello world");
      expect(statusOf(contentDoc, annotationsDoc)).toBe("accepted");
    },
  );

  test("a substitution whose change is invalid keeps its old text too", () => {
    const { contentDoc, annotationsDoc } = setUp();
    const id = substitution(contentDoc, annotationsDoc);
    const forged = (() => {
      const fork = contentDoc.fork();
      const before = fork.oplogVersion();
      fork.getText("content").delete(0, 11);
      fork.commit();
      return fork.export({ mode: "update", from: before });
    })();

    applyDecisionEffects(
      contentDoc,
      annotationsDoc,
      confirmed([id, "accept", forged]),
    );

    expect(text(contentDoc)).toBe("hello world");
    expect(statusOf(contentDoc, annotationsDoc)).toBe("accepted");
  });

  test("an acceptance waits for the dependencies of its change", () => {
    const { contentDoc, annotationsDoc } = setUp();
    const reviewer = new LoroDoc();
    reviewer.import(contentDoc.export({ mode: "snapshot" }));
    reviewer.getText("content").insert(0, "# ");
    reviewer.commit();
    const reviewerAnnotations = new LoroDoc();
    const id = suggestAddition(reviewer, reviewerAnnotations, {
      at: 7,
      text: " dear",
      author: "alice",
    });
    annotationsDoc.import(reviewerAnnotations.export({ mode: "update" }));
    const log = confirmed([
      id,
      "accept",
      changeOf(reviewer, reviewerAnnotations, id),
    ]);

    applyDecisionEffects(contentDoc, annotationsDoc, log);
    expect(text(contentDoc)).toBe("hello world");
    expect(statusOf(contentDoc, annotationsDoc)).toBe("open");

    contentDoc.import(
      reviewer.export({ mode: "update", from: contentDoc.oplogVersion() }),
    );
    applyDecisionEffects(contentDoc, annotationsDoc, log);
    expect(text(contentDoc)).toBe("# hello dear world");
    expect(statusOf(contentDoc, annotationsDoc)).toBe("accepted");
  });

  test("the first confirmed proposal wins, whatever comes after", () => {
    const { contentDoc, annotationsDoc } = setUp();
    const id = createAnnotation(contentDoc, annotationsDoc, {
      type: "deletion",
      start: 6,
      end: 11,
      author: "alice",
    });

    applyDecisionEffects(
      contentDoc,
      annotationsDoc,
      confirmed([id, "reject"], [id, "accept"]),
    );

    expect(text(contentDoc)).toBe("hello world");
    expect(statusOf(contentDoc, annotationsDoc)).toBe("rejected");
  });

  test("nothing happens without a confirmed proposal", () => {
    const { contentDoc, annotationsDoc } = setUp();
    createAnnotation(contentDoc, annotationsDoc, {
      type: "deletion",
      start: 6,
      end: 11,
      author: "alice",
    });

    applyDecisionEffects(contentDoc, annotationsDoc, new DecisionLog());

    expect(text(contentDoc)).toBe("hello world");
    expect(statusOf(contentDoc, annotationsDoc)).toBe("open");
  });

  // The two defects of ADR-0013's table that came from applying twice.
  test("two peers applying the same accepted substitution apply it once", () => {
    const a = setUp();
    const id = substitution(a.contentDoc, a.annotationsDoc);
    const b = { contentDoc: new LoroDoc(), annotationsDoc: new LoroDoc() };
    b.contentDoc.import(a.contentDoc.export({ mode: "update" }));
    b.annotationsDoc.import(a.annotationsDoc.export({ mode: "update" }));
    const log = confirmed([
      id,
      "accept",
      changeOf(a.contentDoc, a.annotationsDoc, id),
    ]);

    applyDecisionEffects(a.contentDoc, a.annotationsDoc, log);
    applyDecisionEffects(b.contentDoc, b.annotationsDoc, log);
    a.contentDoc.import(b.contentDoc.export({ mode: "update" }));
    b.contentDoc.import(a.contentDoc.export({ mode: "update" }));

    expect(text(a.contentDoc)).toBe("bye world");
    expect(text(b.contentDoc)).toBe("bye world");
  });

  // An imported change is not the importer's own operations (ADR-0015):
  // its "accepted" status can reach a peer that never got the change.
  test("an accepted addition still imports its change where the status arrived first", () => {
    const a = setUp();
    const id = suggestAddition(a.contentDoc, a.annotationsDoc, {
      at: 5,
      text: " dear",
      author: "alice",
    });
    const b = { contentDoc: new LoroDoc(), annotationsDoc: new LoroDoc() };
    b.contentDoc.import(a.contentDoc.export({ mode: "update" }));
    const log = confirmed([
      id,
      "accept",
      changeOf(a.contentDoc, a.annotationsDoc, id),
    ]);
    applyDecisionEffects(a.contentDoc, a.annotationsDoc, log);
    // b gets the annotations, status included, but not a's import.
    b.annotationsDoc.import(a.annotationsDoc.export({ mode: "update" }));
    expect(statusOf(b.contentDoc, b.annotationsDoc)).toBe("accepted");

    applyDecisionEffects(b.contentDoc, b.annotationsDoc, log);

    expect(text(b.contentDoc)).toBe("hello dear world");
  });

  test("the old text of a substitution is deleted once, not again where the status arrived first", () => {
    const a = setUp();
    const id = substitution(a.contentDoc, a.annotationsDoc);
    const log = confirmed([
      id,
      "accept",
      changeOf(a.contentDoc, a.annotationsDoc, id),
    ]);
    applyDecisionEffects(a.contentDoc, a.annotationsDoc, log);
    const b = { contentDoc: new LoroDoc(), annotationsDoc: new LoroDoc() };
    // b gets a's own operations (the text, then the deletion) and the
    // status, not a's import.
    const peer = a.contentDoc.peerIdStr;
    const own = a.contentDoc.oplogVersion().get(peer) ?? 0;
    b.contentDoc.import(
      a.contentDoc.export({
        mode: "updates-in-range",
        spans: [{ id: { peer, counter: 0 }, len: own }],
      }),
    );
    expect(text(b.contentDoc)).toBe(" world");
    b.annotationsDoc.import(a.annotationsDoc.export({ mode: "update" }));

    applyDecisionEffects(b.contentDoc, b.annotationsDoc, log);

    expect(text(b.contentDoc)).toBe("bye world");
  });

  // Decision 6 (a): the effect covers the range as resolved when applied,
  // text typed inside it before then included.
  test("text typed inside a pending deletion before the effect is applied is deleted with it", () => {
    const { contentDoc, annotationsDoc } = setUp();
    const id = createAnnotation(contentDoc, annotationsDoc, {
      type: "deletion",
      start: 6,
      end: 11, // "world"
      author: "alice",
    });
    contentDoc.getText("content").insert(8, "XX");
    contentDoc.commit();

    applyDecisionEffects(contentDoc, annotationsDoc, confirmed([id, "accept"]));

    expect(text(contentDoc)).toBe("hello ");
  });

  // The written status is the "applied" mark: a peer reloading later must
  // not delete what was typed at that spot since.
  test("an effect already applied (status no longer open) is never applied again", () => {
    const { contentDoc, annotationsDoc } = setUp();
    const id = createAnnotation(contentDoc, annotationsDoc, {
      type: "deletion",
      start: 6,
      end: 11,
      author: "alice",
    });
    const log = confirmed([id, "accept"]);
    applyDecisionEffects(contentDoc, annotationsDoc, log);
    contentDoc.getText("content").insert(6, "there");
    contentDoc.commit();

    applyDecisionEffects(contentDoc, annotationsDoc, log);

    expect(text(contentDoc)).toBe("hello there");
  });

  test("a confirmed decision waits until its annotation is known", () => {
    const { contentDoc, annotationsDoc } = setUp();
    const log = confirmed(["not-yet-received", "accept"]);

    expect(() =>
      applyDecisionEffects(contentDoc, annotationsDoc, log),
    ).not.toThrow();
    expect(text(contentDoc)).toBe("hello world");
  });

  test("a proposal about a comment is ignored (a comment is resolved, not decided)", () => {
    const { contentDoc, annotationsDoc } = setUp();
    const id = createAnnotation(contentDoc, annotationsDoc, {
      type: "comment",
      start: 0,
      end: 5,
      author: "alice",
      body: "hm",
    });

    applyDecisionEffects(contentDoc, annotationsDoc, confirmed([id, "accept"]));

    expect(statusOf(contentDoc, annotationsDoc)).toBe("open");
  });

  test("a confirmed resolution resolves a comment (ADR-0018, decision 6)", () => {
    const { contentDoc, annotationsDoc } = setUp();
    const id = createAnnotation(contentDoc, annotationsDoc, {
      type: "comment",
      start: 0,
      end: 5,
      author: "alice",
      body: "hm",
    });

    applyDecisionEffects(
      contentDoc,
      annotationsDoc,
      confirmed([id, "resolve"]),
    );

    expect(statusOf(contentDoc, annotationsDoc)).toBe("resolved");
    expect(text(contentDoc)).toBe("hello world");
  });

  test("a resolution about a suggestion is ignored", () => {
    const { contentDoc, annotationsDoc } = setUp();
    createAnnotation(contentDoc, annotationsDoc, {
      type: "deletion",
      start: 6,
      end: 11,
      author: "alice",
    });
    const id = listAnnotations(contentDoc, annotationsDoc)[0]?.id as string;

    applyDecisionEffects(
      contentDoc,
      annotationsDoc,
      confirmed([id, "resolve"]),
    );

    expect(statusOf(contentDoc, annotationsDoc)).toBe("open");
    expect(text(contentDoc)).toBe("hello world");
  });
});

describe("a suggested addition right after a suggested deletion (ADR-0014)", () => {
  test("stays out of the deletion once both are accepted, which deletes only its own text", () => {
    const { contentDoc, annotationsDoc } = setUp("hello world");
    const deletion = createAnnotation(contentDoc, annotationsDoc, {
      type: "deletion",
      start: 0,
      end: 5, // "hello"
      author: "alice",
    });
    const addition = suggestAddition(contentDoc, annotationsDoc, {
      at: 5,
      text: " there",
      author: "bob",
    });
    const change = changeOf(contentDoc, annotationsDoc, addition);

    applyDecisionEffects(
      contentDoc,
      annotationsDoc,
      confirmed([addition, "accept", change]),
    );
    const range = listAnnotations(contentDoc, annotationsDoc).find(
      (a) => a.id === deletion,
    )?.range;
    expect(range).toEqual({ start: 0, end: 5 });

    applyDecisionEffects(
      contentDoc,
      annotationsDoc,
      confirmed([deletion, "accept"]),
    );
    expect(text(contentDoc)).toBe(" there world");
  });
});

describe("suggestAddition", () => {
  test("writes nothing to content and anchors an open addition at the insertion point, with its change and note", () => {
    const { contentDoc, annotationsDoc } = setUp();
    const version = contentDoc.oplogVersion();

    const id = suggestAddition(contentDoc, annotationsDoc, {
      at: 5,
      text: " dear",
      author: "alice",
      note: "warmer",
    });

    expect(text(contentDoc)).toBe("hello world");
    expect(contentDoc.oplogVersion().compare(version)).toBe(0);
    const [annotation] = listAnnotations(contentDoc, annotationsDoc);
    expect(annotation).toMatchObject({
      id,
      type: "addition",
      status: "open",
      author: "alice",
      note: "warmer",
      range: { start: 5, end: 5 },
    });
    expect(annotation?.change).toBeInstanceOf(Uint8Array);
  });

  test("refuses an empty proposed text", () => {
    const { contentDoc, annotationsDoc } = setUp();
    expect(() =>
      suggestAddition(contentDoc, annotationsDoc, {
        at: 0,
        text: "",
        author: "a",
      }),
    ).toThrow();
    expect(listAnnotations(contentDoc, annotationsDoc)).toHaveLength(0);
  });
});

describe("the cost of applying decisions", () => {
  // Was quadratic: every decision re-listed (and resolved) every annotation.
  test("resolves only the decided annotations, each once", () => {
    const words = Array.from({ length: 20 }, (_, i) => `w${i}`);
    const { contentDoc, annotationsDoc } = setUp(words.join(" "));
    const ids = words.map((word, i) => {
      const start = words.slice(0, i).join(" ").length + (i > 0 ? 1 : 0);
      return createAnnotation(contentDoc, annotationsDoc, {
        type: "deletion",
        start,
        end: start + word.length,
        author: "alice",
      });
    });
    const decided = ids.slice(0, 5);
    resetCounters();

    applyDecisionEffects(
      contentDoc,
      annotationsDoc,
      confirmed(...decided.map((id): [string, Decision] => [id, "accept"])),
    );

    expect(counter("cursor.resolve")).toBe(2 * decided.length);
    expect(
      listAnnotations(contentDoc, annotationsDoc).filter(
        (a) => a.status === "accepted",
      ),
    ).toHaveLength(5);
  });
});

describe("watchDecisionEffects", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("applies a decision once it is confirmed", async () => {
    const { contentDoc, annotationsDoc } = setUp();
    const id = createAnnotation(contentDoc, annotationsDoc, {
      type: "deletion",
      start: 6,
      end: 11,
      author: "alice",
    });
    const log = new DecisionLog();
    const index = new AnnotationIndex(contentDoc, annotationsDoc, log);
    const stop = watchDecisionEffects(index, log);

    log.add([
      {
        seq: 1,
        record: encodeProposal({
          proposalId: "p",
          annotationId: id,
          decision: "accept",
          author: "bob",
        }),
      },
    ]);
    await flush();

    expect(text(contentDoc)).toBe("hello ");
    stop();
  });

  test("applies a confirmed decision once its annotation arrives on the annotations channel", async () => {
    const origin = setUp();
    const id = createAnnotation(origin.contentDoc, origin.annotationsDoc, {
      type: "deletion",
      start: 6,
      end: 11,
      author: "alice",
    });
    const contentDoc = new LoroDoc();
    contentDoc.import(origin.contentDoc.export({ mode: "update" }));
    const annotationsDoc = new LoroDoc();
    const log = confirmed([id, "accept"]);
    const index = new AnnotationIndex(contentDoc, annotationsDoc, log);
    const stop = watchDecisionEffects(index, log);

    annotationsDoc.import(origin.annotationsDoc.export({ mode: "update" }));
    await flush();

    expect(text(contentDoc)).toBe("hello ");
    stop();
  });
});

describe("adopting imported changes (docs/phase-5-modele-acces.md, analysis A)", () => {
  test("an accepted addition's change is adopted once, right after its import", () => {
    const { contentDoc, annotationsDoc } = setUp();
    const id = suggestAddition(contentDoc, annotationsDoc, {
      at: 5,
      text: " dear",
      author: "alice",
    });
    const change = changeOf(contentDoc, annotationsDoc, id);
    const adopted: string[] = [];
    const log = confirmed([id, "accept", change]);

    for (let i = 0; i < 2; i++) {
      applyDecisionEffects(contentDoc, annotationsDoc, log, (bytes) =>
        adopted.push(
          `${text(contentDoc)}|${Buffer.from(bytes).equals(Buffer.from(change))}`,
        ),
      );
    }

    expect(adopted).toEqual(["hello dear world|true"]);
  });

  test("an accepted substitution's replacement is adopted", () => {
    const { contentDoc, annotationsDoc } = setUp();
    const id = substitution(contentDoc, annotationsDoc);
    const change = changeOf(contentDoc, annotationsDoc, id);
    const adopted: Uint8Array[] = [];

    applyDecisionEffects(
      contentDoc,
      annotationsDoc,
      confirmed([id, "accept", change]),
      (bytes) => adopted.push(bytes),
    );

    expect(adopted).toEqual([change]);
  });

  test("a change imported where only the status arrived is adopted too", () => {
    const a = setUp();
    const id = suggestAddition(a.contentDoc, a.annotationsDoc, {
      at: 5,
      text: " dear",
      author: "alice",
    });
    const b = { contentDoc: new LoroDoc(), annotationsDoc: new LoroDoc() };
    b.contentDoc.import(a.contentDoc.export({ mode: "update" }));
    const log = confirmed([
      id,
      "accept",
      changeOf(a.contentDoc, a.annotationsDoc, id),
    ]);
    applyDecisionEffects(a.contentDoc, a.annotationsDoc, log);
    b.annotationsDoc.import(a.annotationsDoc.export({ mode: "update" }));
    const adopted: Uint8Array[] = [];

    applyDecisionEffects(b.contentDoc, b.annotationsDoc, log, (bytes) =>
      adopted.push(bytes),
    );

    expect(adopted).toHaveLength(1);
  });

  test("a change already received on content is not adopted again", () => {
    const a = setUp();
    const id = suggestAddition(a.contentDoc, a.annotationsDoc, {
      at: 5,
      text: " dear",
      author: "alice",
    });
    const change = changeOf(a.contentDoc, a.annotationsDoc, id);
    a.contentDoc.import(change); // an editor published it already
    const adopted: Uint8Array[] = [];

    applyDecisionEffects(
      a.contentDoc,
      a.annotationsDoc,
      confirmed([id, "accept", change]),
      (bytes) => adopted.push(bytes),
    );

    expect(text(a.contentDoc)).toBe("hello dear world");
    expect(adopted).toEqual([]);
  });
});

// Phase 9, E3: display keeps Loro's update of a cursor whose character was
// deleted; with an insertion concurrent with that deletion it may resolve
// one character off. An effect deletes text: it reads the exact range.
describe("an accepted deletion, after display kept an update", () => {
  test("deletes the exact range, never what was typed concurrently next to it", () => {
    const { contentDoc, annotationsDoc } = setUp("abcd");
    contentDoc.setPeerId(1n);
    const id = createAnnotation(contentDoc, annotationsDoc, {
      type: "deletion",
      start: 1,
      end: 3, // "bc"
      author: "bob",
    });
    const other = new LoroDoc();
    other.setPeerId(2n);
    other.import(contentDoc.export({ mode: "snapshot" }));
    other.getText("content").insert(3, "X"); // right after "c", concurrently
    other.commit();
    contentDoc.getText("content").delete(2, 1); // "c" gone: "abd"
    contentDoc.commit();
    new AnnotationIndex(contentDoc, annotationsDoc).current(); // display
    contentDoc.import(
      other.export({ mode: "update", from: contentDoc.oplogVersion() }),
    );
    expect(contentDoc.getText("content").toString()).toBe("abXd");

    applyDecisionEffects(contentDoc, annotationsDoc, confirmed([id, "accept"]));

    expect(contentDoc.getText("content").toString()).toBe("aXd");
  });
});
