// @vitest-environment jsdom
// Attached images in a host's editor (ADR-0057 §9): found by their text,
// drawn by the page's widget; the source on the caret's line.
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, test } from "vitest";
import { t } from "../i18n/index.js";
import type { AttachedImages } from "../view-model/attached-images.js";
import { hostedAttachedImages } from "./hosted-attached-images.js";
import { attachedImagesFacet } from "./live-widgets.js";

const A = "AAECAwQFBgcICQoLDA0ODw";
const images = {
  // As the view's: an identifier that cites nothing is absent.
  state: (id: string) =>
    id ? { kind: "shown", url: "blob:x/1", format: "png" } : { kind: "absent" },
  subscribe: () => () => {},
} as unknown as AttachedImages;

function host(doc: string) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: EditorState.create({ doc }), parent });
  view.dispatch({
    effects: StateEffect.appendConfig.of([
      attachedImagesFacet.of(images),
      hostedAttachedImages(),
    ]),
  });
  return view;
}

describe("attached images in a host's editor", () => {
  test("each drawn by the page's widget, the rest as written", () => {
    const view = host(
      `a ![x](attachment:${A}) b\n![y](https://e.org/i.png)\n![z](attachment:nope)`,
    );
    const drawn = Array.from(
      view.contentDOM.querySelectorAll(".cm-live-attached-image"),
    );
    expect(
      drawn.map(
        (box) =>
          box.querySelector("img")?.getAttribute("src") ?? box.textContent,
      ),
    ).toEqual(["blob:x/1", `z${t().attachedImageAbsent}`]);
    expect(view.contentDOM.textContent).toContain("![y](https://e.org/i.png)");
  });

  test("the caret's line shows its source", () => {
    const view = host(`![x](attachment:${A})`);
    view.focus();
    view.dispatch({ selection: { anchor: 1 } });
    expect(view.contentDOM.textContent).toBe(`![x](attachment:${A})`);
  });
});
