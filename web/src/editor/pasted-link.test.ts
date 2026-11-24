// @vitest-environment jsdom
// A document's full link pasted into the text (docs/phase-19-liens.md,
// decision 12): what goes in is the address without its key, for whoever
// already has the document (ADR-0045 §2); the key never reaches the text,
// not even for a moment (LK1).
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc } from "loro-crdt";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { testLink } from "../../lib/src/keyring/test-support/links.js";
import { createDocumentEditor } from "./editor.js";
import { keylessForm, pastedLinks } from "./pasted-link.js";

const ORIGIN = "https://collab.test";
const PAGE = `${ORIGIN}/`;

describe("keylessForm", () => {
  test("a full link of this server: its address without the key, titled if the list knows it", () => {
    const link = testLink("b", "edit", 0, PAGE);
    expect(keylessForm(link, ORIGIN, () => undefined)).toEqual({
      insert: `<${ORIGIN}/?doc=b>`,
      link,
      documentId: "b",
    });
    expect(keylessForm(` ${link}\n`, ORIGIN, () => "Plan [v2]")).toEqual({
      insert: `[Plan \\[v2\\]](${ORIGIN}/?doc=b)`,
      link,
      documentId: "b",
    });
  });

  test("a heading asked for (`h`): kept, the key taken out", () => {
    const link = `${testLink("b", "read", 0, PAGE)}&h=Partie%20un`;
    expect(keylessForm(link, ORIGIN, () => undefined)?.insert).toBe(
      `<${ORIGIN}/?doc=b#h=Partie%20un>`,
    );
  });

  test("anything else: not converted", () => {
    for (const text of [
      testLink("b", "edit", 0, "https://elsewhere.test/"),
      `${ORIGIN}/?doc=b`,
      `${ORIGIN}/?doc=b#nothing`,
      `${ORIGIN}/#k=x&r=edit.y`,
      `voir ${testLink("b", "edit", 0, PAGE)}`,
      "du texte",
      "",
    ]) {
      expect(
        keylessForm(text, ORIGIN, () => undefined),
        text,
      ).toBeNull();
    }
  });

  test("never a key nor a role secret in what goes in (LK1), whatever the title", () =>
    hegel.test(
      (tc) => {
        const role = tc.draw(gs.sampledFrom(["read", "suggest", "edit"]));
        const id = tc.draw(gs.sampledFrom(["b", "d-1", "x_y"]));
        const h = tc.draw(
          gs.sampledFrom(["", "&h=A", "&h=k%3Dx", "&h=r%3Dedit.y"]),
        );
        const link = `${testLink(id, role, 0, PAGE)}${h}`;
        // A title the list holds, written by anyone, or none.
        const title = tc.draw(gs.booleans())
          ? tc.draw(gs.text({ maxSize: 12 }))
          : undefined;
        const out = keylessForm(link, ORIGIN, () => title);
        if (!out) throw new Error(`not converted: ${link}`);
        const key =
          new URLSearchParams(new URL(link).hash.slice(1)).get("k") ?? "";
        const secret =
          (
            new URLSearchParams(new URL(link).hash.slice(1)).get("r") ?? ""
          ).split(".")[1] ?? "";
        if (out.insert.includes(key) || out.insert.includes(secret)) {
          throw new Error(`the key reached the text: ${out.insert}`);
        }
        if (!out.insert.includes(`?doc=${id}`)) {
          throw new Error(`the document not named: ${out.insert}`);
        }
      },
      { testCases: 300 },
    ));
});

describe("pasting into the editor", () => {
  // What jsdom lacks: the boxes CodeMirror measures once asked to scroll.
  const saved = {
    rects: Range.prototype.getClientRects,
    box: Range.prototype.getBoundingClientRect,
  };
  beforeAll(() => {
    Range.prototype.getClientRects = () =>
      ({
        length: 0,
        item: () => null,
        [Symbol.iterator]: [][Symbol.iterator],
      }) as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect();
  });
  afterAll(() => {
    Range.prototype.getClientRects = saved.rects;
    Range.prototype.getBoundingClientRect = saved.box;
  });

  const parents: Element[] = [];
  const views: { destroy(): void }[] = [];
  afterEach(() => {
    for (const view of views.splice(0)) view.destroy();
    for (const parent of parents.splice(0)) parent.remove();
  });

  function setUp() {
    const doc = new LoroDoc();
    doc.getText("content").insert(0, "Avant ");
    doc.commit();
    const parent = document.createElement("div");
    document.body.append(parent);
    parents.push(parent);
    const editor = createDocumentEditor(parent, doc, {});
    views.push(editor.view);
    const converted: { link: string; keep: () => boolean }[] = [];
    editor.view.dispatch({
      effects: pastedLinks({
        origin: ORIGIN,
        titleOf: () => undefined,
        converted: (link, keep) => converted.push({ link, keep }),
      }),
      selection: { anchor: 6 },
    });
    const paste = (text: string) => {
      // jsdom has no DataTransfer: what the handler reads of one.
      const data = {
        getData: (type: string) => (type === "text/plain" ? text : ""),
      };
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: data });
      editor.view.contentDOM.dispatchEvent(event);
      return event.defaultPrevented;
    };
    return { doc, view: editor.view, converted, paste };
  }

  test("a full link: the keyless address in the text, in Loro too, never the key", () => {
    const link = testLink("b", "edit", 0, PAGE);
    const { doc, view, converted, paste } = setUp();
    const seen: string[] = [];
    const stop = doc.subscribe(() =>
      seen.push(doc.getText("content").toString()),
    );

    expect(paste(link)).toBe(true);

    expect(view.state.doc.toString()).toBe(`Avant <${ORIGIN}/?doc=b>`);
    expect(doc.getText("content").toString()).toBe(`Avant <${ORIGIN}/?doc=b>`);
    const key = new URLSearchParams(new URL(link).hash.slice(1)).get("k") ?? "";
    expect(seen.some((text) => text.includes(key))).toBe(false);
    expect(converted.map((c) => c.link)).toEqual([link]);
    stop();
  });

  test("« Paste with the key »: the address replaced by the link, where it is now", () => {
    const link = testLink("b", "edit", 0, PAGE);
    const { view, converted, paste } = setUp();
    paste(link);
    view.dispatch({ changes: { from: 0, insert: "Tout " } });

    expect(converted[0]?.keep()).toBe(true);

    expect(view.state.doc.toString()).toBe(`Tout Avant ${link}`);
    // Once only.
    expect(converted[0]?.keep()).toBe(false);
  });

  test("the address changed meanwhile: nothing replaced", () => {
    const link = testLink("b", "edit", 0, PAGE);
    const { view, converted, paste } = setUp();
    paste(link);
    view.dispatch({ changes: { from: 7, to: 8, insert: "H" } });
    const before = view.state.doc.toString();

    expect(converted[0]?.keep()).toBe(false);

    expect(view.state.doc.toString()).toBe(before);
  });

  test("anything else is pasted as the editor pastes it", () => {
    const { view, converted, paste } = setUp();
    paste("du texte");
    paste(` ${ORIGIN}/?doc=b`);
    expect(view.state.doc.toString()).toBe(`Avant du texte ${ORIGIN}/?doc=b`);
    expect(converted).toEqual([]);
  });
});
