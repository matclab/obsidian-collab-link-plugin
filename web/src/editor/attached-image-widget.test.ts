// @vitest-environment jsdom
// An attached image in the editor (ADR-0057 §8): its text and why until
// the view has it, then drawn in place as it arrives, without the
// decorations computed again (AGENTS.md §6); without the view's images,
// its text.
import { forceParsing } from "@codemirror/language";
import { StateEffect } from "@codemirror/state";
import { LoroDoc } from "loro-crdt";
import { afterEach, describe, expect, test } from "vitest";
import { t } from "../i18n/index.js";
import { countDuring } from "../perf/index.js";
import type {
  AttachedImages,
  AttachedState,
} from "../view-model/attached-images.js";
import { createDocumentEditor } from "./editor.js";
import { attachedImagesFacet } from "./live-widgets.js";

const A = "AAECAwQFBgcICQoLDA0ODw";
const parents: Element[] = [];
afterEach(() => {
  for (const parent of parents.splice(0)) parent.remove();
});

function images() {
  const states = new Map<string, AttachedState>();
  const listeners = new Set<(ids: readonly string[]) => void>();
  const service: AttachedImages = {
    state: (id) => states.get(id) ?? { kind: "loading" },
    peek: (id) => states.get(id),
    add() {},
    opened: async () => undefined,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {},
  };
  return {
    service,
    listeners,
    arrive(id: string, state: AttachedState) {
      states.set(id, state);
      for (const listener of [...listeners]) listener([id]);
    },
  };
}

function editor(text: string, service?: AttachedImages) {
  const doc = new LoroDoc();
  doc.getText("content").insert(0, text);
  doc.commit();
  const parent = document.createElement("div");
  document.body.append(parent);
  parents.push(parent);
  const created = createDocumentEditor(parent, doc, { livePreview: true });
  if (service) {
    created.view.dispatch({
      effects: StateEffect.appendConfig.of(attachedImagesFacet.of(service)),
    });
  }
  forceParsing(created.view, created.view.state.doc.length, 5000);
  return created;
}

describe("an attached image in the editor", () => {
  test("its text and why, then drawn in place, the decorations untouched", () => {
    const { service, arrive, listeners } = images();
    const { view } = editor(`Voir ![un chien](attachment:${A}) ici.`, service);
    const box = () => view.contentDOM.querySelector(".cm-live-attached-image");
    expect(box()?.textContent).toBe(`un chien${t().attachedImageLoading}`);

    const built = countDuring("live.build", () =>
      arrive(A, { kind: "shown", url: "blob:x/1", format: "png" }),
    );

    expect(built).toBe(0);
    const image = box()?.querySelector("img");
    expect(image?.getAttribute("src")).toBe("blob:x/1");
    expect(image?.getAttribute("alt")).toBe("un chien");
    expect(listeners.size, "drawn: it listens no more").toBe(0);
  });

  test("one that can't be shown says why; without the view's images, absent", () => {
    const { service, arrive } = images();
    arrive(A, { kind: "unreadable" });
    const { view } = editor(`![x](attachment:${A})`, service);
    expect(view.contentDOM.textContent).toBe(`x${t().attachedImageUnreadable}`);
    const bare = editor(`![x](attachment:${A})`);
    expect(bare.view.contentDOM.textContent).toBe(
      `x${t().attachedImageAbsent}`,
    );
  });

  test("its line under the caret shows its source", () => {
    const { service } = images();
    const { view } = editor(`![x](attachment:${A})`, service);
    view.focus();
    view.dispatch({ selection: { anchor: 2 } });
    expect(view.contentDOM.textContent).toBe(`![x](attachment:${A})`);
  });
});
