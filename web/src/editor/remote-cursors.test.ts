// @vitest-environment jsdom
// The others' cursors in the editor (ADR-0025 §7): a caret with their
// name and color, their selection shaded; resolved when their state
// arrives, and after an import only while one doesn't resolve (R-P4);
// never on the page's own typing (phase 7, P5).
import { LoroDoc } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AnnotationIndex } from "../../lib/src/annotations/index.js";
import { Presence } from "../../lib/src/presence/presence.js";
import { t } from "../i18n/index.js";
import { counters, resetCounters } from "../perf/index.js";
import { createDocumentEditor } from "./editor.js";
import { attachRemoteCursors, nameRemoteCursors } from "./remote-cursors.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

function setUp(text = "hello world", aliceName = () => "alice") {
  const docA = new LoroDoc();
  docA.getText("content").insert(0, text);
  docA.commit();
  const docB = new LoroDoc();
  docB.import(docA.export({ mode: "snapshot" }));
  const sent: Uint8Array[] = [];
  const alice = new Presence({
    doc: docA,
    name: aliceName,
    publish: (bytes) => sent.push(bytes),
  });
  const bob = new Presence({ doc: docB, name: () => "bob", publish: () => {} });
  const editor = createDocumentEditor(document.createElement("div"), docB);
  const index = new AnnotationIndex(docB, new LoroDoc());
  attachRemoteCursors(editor.view, bob, index);
  const deliver = async () => {
    vi.advanceTimersByTime(200);
    for (const bytes of sent.splice(0)) bob.receive(bytes);
    await Promise.resolve();
    await Promise.resolve();
  };
  const carets = () =>
    Array.from(
      editor.view.dom.querySelectorAll(".cm-remote-caret"),
      (caret) => caret.textContent,
    );
  const shaded = () =>
    Array.from(
      editor.view.dom.querySelectorAll(".cm-remote-selection"),
      (mark) => mark.textContent,
    ).join("");
  const titles = () =>
    Array.from(
      editor.view.dom.querySelectorAll<HTMLElement>(".cm-remote-caret"),
      (caret) => caret.title,
    );
  return { docA, docB, alice, editor, deliver, carets, shaded, titles };
}

describe("remote cursors", () => {
  test("another page's caret and selection show, named", async () => {
    const { alice, deliver, carets, shaded } = setUp();

    alice.setSelection(6, 11);
    await deliver();

    expect(carets()).toEqual(["alice"]);
    expect(shaded()).toBe("world");
  });

  test("a caret and its name are not read in the text by a screen reader (11e.2)", async () => {
    const { alice, editor, deliver } = setUp();
    alice.setSelection(6, 6);
    await deliver();
    const caret = editor.view.dom.querySelector(".cm-remote-caret");
    expect(caret?.getAttribute("aria-hidden")).toBe("true");
  });

  test("phase 7, P5: typing here resolves nothing, and the caret follows the text", async () => {
    const { alice, editor, deliver, shaded } = setUp();
    alice.setSelection(6, 11);
    await deliver();
    resetCounters();

    editor.view.dispatch({ changes: { from: 0, insert: ">> " } });
    await Promise.resolve();

    expect(counters()["presence.resolve"] ?? 0).toBe(0);
    expect(shaded()).toBe("world");
  });

  test("R-P4: a caret on text not received yet shows once the text comes, and only then are imports looked at", async () => {
    const { docA, docB, alice, deliver, carets } = setUp("");
    const before = docA.oplogVersion();
    docA.getText("content").insert(0, "typed by alice");
    docA.commit();
    alice.setSelection(6, 8);
    await deliver();
    expect(carets()).toEqual([]);

    docB.import(docA.export({ mode: "update", from: before }));
    await Promise.resolve();
    await Promise.resolve();
    expect(carets()).toEqual(["alice"]);

    // Everything resolves: a further import resolves nothing.
    resetCounters();
    const more = docA.oplogVersion();
    docA.getText("content").insert(0, "x");
    docA.commit();
    docB.import(docA.export({ mode: "update", from: more }));
    await Promise.resolve();
    await Promise.resolve();
    expect(counters()["presence.resolve"] ?? 0).toBe(0);
  });

  test("R-P7: a state sent again unchanged resolves nothing; a moved or renamed one does", async () => {
    let name = "alice";
    const { alice, deliver, carets } = setUp(undefined, () => name);
    alice.setSelection(6, 11);
    await deliver();
    resetCounters();

    vi.advanceTimersByTime(10_000); // the heartbeat
    await deliver();
    expect(counters()["presence.resolve"] ?? 0).toBe(0);

    alice.setSelection(0, 5);
    await deliver();
    expect(counters()["presence.resolve"] ?? 0).toBe(1);

    name = "alicia";
    alice.renamed();
    await deliver();
    expect(counters()["presence.resolve"] ?? 0).toBe(2);
    expect(carets()).toEqual(["alicia"]);
  });

  test("gone, the caret goes", async () => {
    const { alice, deliver, carets } = setUp();
    alice.setSelection(1, 1);
    await deliver();
    expect(carets()).toEqual(["alice"]);

    alice.leave();
    await deliver();

    expect(carets()).toEqual([]);
  });

  // Analysis 18o.2: a presence attested carries the attested name on its
  // caret, as in the list of those present; until then, the name chosen.
  test("an attested presence's caret carries the attested name", async () => {
    const { alice, editor, deliver, carets, titles } = setUp();
    alice.setSelection(3, 3);
    await deliver();
    expect(carets()).toEqual(["alice"]);
    expect(titles()).toEqual([t().cursorNotVerified("alice")]);
    let attested = false;
    const listeners = new Set<() => void>();
    nameRemoteCursors(editor.view, {
      name: (other) =>
        attested
          ? { name: "Alice Hopper", attested: true }
          : { name: other.name, attested: false },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });

    attested = true;
    for (const listener of listeners) listener();

    expect(carets()).toEqual(["Alice Hopper"]);
    expect(titles()).toEqual([t().cursorVerified("Alice Hopper")]);
  });
});
