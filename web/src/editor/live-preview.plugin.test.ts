// @vitest-environment jsdom
// Live formatting's budget in the editor (phase 11b.2, decision 5): at most
// one computation per update, of the part on screen; none for an update
// that changes neither the text, the selection, the focus nor the part on
// screen (an annotation's decorations, a remote cursor).

import { forceParsing } from "@codemirror/language";
import { StateEffect } from "@codemirror/state";
import { LoroDoc } from "loro-crdt";
import { afterEach, describe, expect, test } from "vitest";
import { countDuring } from "../perf/index.js";
import { createDocumentEditor } from "./editor.js";

const parents: Element[] = [];
afterEach(() => {
  for (const parent of parents.splice(0)) parent.remove();
});

function editor(text = "# Titre\n\nDu **gras** et [un lien](https://x.org).") {
  const doc = new LoroDoc();
  doc.getText("content").insert(0, text);
  doc.commit();
  const parent = document.createElement("div");
  document.body.append(parent);
  parents.push(parent);
  const created = createDocumentEditor(parent, doc, { livePreview: true });
  // Parsed to the end: under load, the parser stops at its time budget.
  forceParsing(created.view, created.view.state.doc.length, 5000);
  return { doc, ...created };
}

describe("livePreviewPlugin", () => {
  test("a keystroke computes once", () => {
    const { view } = editor();
    expect(
      countDuring("live.build", () =>
        view.dispatch({
          changes: { from: view.state.doc.length, insert: "k" },
          userEvent: "input.type",
        }),
      ),
    ).toBe(1);
  });

  test("a remote edit computes once", () => {
    const { doc } = editor();
    const peer = new LoroDoc();
    peer.import(doc.export({ mode: "snapshot" }));
    peer.getText("content").insert(0, "Hello ");
    peer.commit();
    expect(
      countDuring("live.build", () =>
        doc.import(peer.export({ mode: "update", from: doc.oplogVersion() })),
      ),
    ).toBe(1);
  });

  test("a caret move computes once; focus once", () => {
    const { view } = editor();
    expect(
      countDuring("live.build", () =>
        view.dispatch({ selection: { anchor: 3 } }),
      ),
    ).toBe(1);
    expect(countDuring("live.build", () => view.focus())).toBeLessThanOrEqual(
      1,
    );
  });

  test("an update that changes none of what it reads computes nothing", () => {
    const { view } = editor();
    const effect = StateEffect.define<null>();
    expect(
      countDuring("live.build", () =>
        view.dispatch({ effects: effect.of(null) }),
      ),
    ).toBe(0);
  });

  test("the formatting switches on and off without touching the text", () => {
    const { view, doc, ...editorApi } = editor("Du **gras**.");
    const shownText = () => view.contentDOM.textContent ?? "";
    expect(editorApi.formatting()).toBe(true);
    expect(shownText()).toBe("Du gras.");

    editorApi.setFormatting(false);
    expect(editorApi.formatting()).toBe(false);
    expect(shownText()).toBe("Du **gras**.");
    // Off, nothing is computed.
    expect(
      countDuring("live.build", () =>
        view.dispatch({ changes: { from: 0, insert: "k" } }),
      ),
    ).toBe(0);

    editorApi.setFormatting(true);
    expect(shownText()).toBe("kDu gras.");
    expect(doc.getText("content").toString()).toBe("kDu **gras**.");
  });
});
