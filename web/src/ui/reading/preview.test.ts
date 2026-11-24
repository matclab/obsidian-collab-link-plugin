// @vitest-environment jsdom
import { EditorView } from "@codemirror/view";
import type { RenderOptions } from "pele";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { t } from "../../i18n/index.js";
import { counter, resetCounters } from "../../perf/index.js";
import { type DiagramModule, createPreview } from "./preview.js";

class FakeRefusal extends Error {}

/** Pele as the preview sees it: a diagram is its source as SVG text; a
 * source `fail` picks is refused, as Pele refuses what it cannot draw. */
function fakePele(fail?: (source: string) => boolean) {
  const rendered: string[] = [];
  const options: RenderOptions[] = [];
  return {
    rendered,
    options,
    module: {
      async render(source: string, given: RenderOptions) {
        rendered.push(source);
        options.push(given);
        if (fail?.(source)) throw new FakeRefusal(`Parse error: ${source}`);
        return {
          svg: `<svg xmlns="http://www.w3.org/2000/svg" class="pele"><text>${source}</text></svg>`,
        };
      },
      refuses: (error: unknown) => error instanceof FakeRefusal,
    } as DiagramModule,
  };
}

function setUp(text: string, pele = fakePele()) {
  const view = new EditorView({
    doc: text,
    parent: document.createElement("div"),
  });
  const container = document.createElement("div");
  const loaded: string[] = [];
  const preview = createPreview(container, view, {
    katex: () => {
      loaded.push("katex");
      return import("katex").then((module) => module.default);
    },
    diagrams: async () => {
      loaded.push("diagrams");
      return pele.module;
    },
  });
  const type = (insert: string) =>
    view.dispatch({ changes: { from: view.state.doc.length, insert } });
  return { view, container, preview, type, loaded };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetCounters();
});
afterEach(() => vi.useRealTimers());

describe("createPreview", () => {
  test("a task's box has a name, for a screen reader (11e.2)", () => {
    const { container, preview } = setUp("- [ ] a\n- [x] b");
    preview.show();
    expect(
      Array.from(container.querySelectorAll("input"), (box) =>
        box.getAttribute("aria-label"),
      ),
    ).toEqual(["Task", "Task"]);
  });

  test("a task's box is read only: neither a click nor a key ticks it", () => {
    const { container, view, preview } = setUp("- [ ] a\n- [x] b");
    preview.show();
    const boxes = () =>
      Array.from(container.querySelectorAll("input"), (box) => box.checked);
    // A key's Space on a focused box is a click too.
    for (const box of Array.from(container.querySelectorAll("input")))
      box.click();
    expect(boxes()).toEqual([false, true]);
    expect(view.state.doc.toString()).toBe("- [ ] a\n- [x] b");
  });

  test("renders nothing while hidden, the current text once shown", () => {
    const { container, preview, type } = setUp("# Title");
    type(" more");
    vi.runAllTimers();
    expect(counter("preview.render")).toBe(0);

    preview.show();

    expect(container.querySelector("h1")?.textContent).toBe("Title more");
    expect(counter("preview.render")).toBe(1);
  });

  test("renders a burst of edits once, 150 ms after the last, never within a keystroke", () => {
    const { container, preview, type } = setUp("a");
    preview.show();
    resetCounters();

    for (const letter of "bcde") {
      type(letter);
      vi.advanceTimersByTime(100);
    }
    expect(counter("preview.render")).toBe(0);
    vi.advanceTimersByTime(49);
    expect(counter("preview.render")).toBe(0);
    vi.advanceTimersByTime(1);

    expect(counter("preview.render")).toBe(1);
    expect(container.textContent?.trim()).toBe("abcde");
  });

  test("an edit made while hidden shows once the preview is shown again", () => {
    const { container, preview, type } = setUp("a");
    preview.show();
    preview.hide();
    type("b");
    vi.runAllTimers();
    expect(counter("preview.render")).toBe(1);

    preview.show();
    expect(container.textContent?.trim()).toBe("ab");
  });

  test("loads KaTeX only for a text with formulas, and renders each formula in place", async () => {
    const plain = setUp("no math, 5 $ et 10 $");
    plain.preview.show();
    await plain.preview.settled();
    expect(plain.loaded).toEqual([]);

    const { container, preview, loaded } = setUp(
      "inline $x^2$\n\n$$\\frac12$$",
    );
    preview.show();
    await preview.settled();

    expect(loaded).toEqual(["katex"]);
    expect(container.querySelector("span.math .katex")).not.toBeNull();
    expect(container.querySelector("div.math .katex-display")).not.toBeNull();
    expect(counter("katex.render")).toBe(2);
  });

  test("renders a formula once, however often the text around it changes", async () => {
    const { preview, type } = setUp("$x^2$");
    preview.show();
    await preview.settled();
    resetCounters();

    type(" and more");
    vi.runAllTimers();
    await preview.settled();

    expect(counter("preview.render")).toBe(1);
    expect(counter("katex.render")).toBe(0);
  });

  test("shows an invalid or untrusted formula's error in its place, and the others", async () => {
    const { container, preview } = setUp(
      "$\\frac{$ $\\href{javascript:alert(1)}{x}$ $y$",
    );
    preview.show();
    await preview.settled();

    const formulas = container.querySelectorAll(".math");
    expect(formulas[0]?.querySelector(".katex-error")).not.toBeNull();
    expect(formulas[1]?.querySelector("a")).toBeNull();
    expect(formulas[2]?.querySelector(".katex")).not.toBeNull();
  });

  test("loads Pele only for a text with diagrams, and draws in place with our options", async () => {
    const plain = setUp("```js\nx\n```");
    plain.preview.show();
    await plain.preview.settled();
    expect(plain.loaded).toEqual([]);

    const pele = fakePele();
    const { container, preview, loaded } = setUp(
      "```mermaid\ngraph TD\n```",
      pele,
    );
    preview.show();
    await preview.settled();

    expect(loaded).toEqual(["diagrams"]);
    expect(pele.options).toEqual([
      expect.objectContaining({
        links: false,
        images: false,
        autoDirection: false,
        idPrefix: expect.stringMatching(/^diagram-\d+$/),
      }),
    ]);
    const svg = container.querySelector(".mermaid > svg");
    expect(svg?.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(svg?.textContent).toBe("graph TD\n");
    expect(container.querySelector(".mermaid iframe")).toBeNull();
    expect(container.querySelector(".mermaid pre")).toBeNull();
  });

  test("gives each diagram ids of its own", async () => {
    const pele = fakePele();
    const { preview } = setUp("```mermaid\nA\n```\n```mermaid\nB\n```", pele);
    preview.show();
    await preview.settled();

    const [a, b] = pele.options.map((given) => given.idPrefix);
    expect(a).not.toBe(b);
  });

  test("draws a diagram once, however often the text around it changes", async () => {
    const pele = fakePele();
    const { container, preview, type } = setUp("```mermaid\nA\n```\n", pele);
    preview.show();
    await preview.settled();

    type("more text");
    vi.runAllTimers();
    await preview.settled();

    expect(pele.rendered).toEqual(["A\n"]);
    expect(counter("diagram.render")).toBe(1);
    expect(container.querySelector(".mermaid svg")).not.toBeNull();
  });

  test("draws one source in each of its places, once", async () => {
    const pele = fakePele();
    const { container, preview } = setUp(
      "```mermaid\nA\n```\n\ntext\n\n```mermaid\nA\n```",
      pele,
    );
    preview.show();
    await preview.settled();

    expect(container.querySelectorAll(".mermaid svg")).toHaveLength(2);
    expect(counter("diagram.render")).toBe(1);
  });

  test("shows a diagram's error in its place, its source kept, and draws the others", async () => {
    const pele = fakePele((source) => source.startsWith("bad"));
    const { container, preview } = setUp(
      "```mermaid\nbad\n```\n```mermaid\ngood\n```",
      pele,
    );
    preview.show();
    await preview.settled();

    const [bad, good] = Array.from(container.querySelectorAll(".mermaid"));
    expect(bad?.querySelector(".render-error")?.textContent).toContain(
      "Parse error",
    );
    expect(bad?.querySelector("pre")?.textContent).toBe("bad\n");
    expect(good?.querySelector("svg")).not.toBeNull();
  });

  test("never inserts a drawing the check refuses (ADR-0042, decision 4)", async () => {
    const pele = fakePele();
    pele.module.render = async () => ({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
    });
    const { container, preview, type } = setUp("```mermaid\nA\n```", pele);
    preview.show();
    await preview.settled();

    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector(".mermaid .render-error")).not.toBeNull();
    expect(container.querySelector(".mermaid pre")?.textContent).toBe("A\n");

    // A refusal, like Pele's, is not tried again for the same source.
    type("\nmore");
    vi.runAllTimers();
    await preview.settled();
    expect(counter("diagram.render")).toBe(1);
  });

  test("keeps the source of formulas and diagrams when their library fails to load", async () => {
    const view = new EditorView({
      doc: "$x$\n```mermaid\nA\n```",
      parent: document.createElement("div"),
    });
    const container = document.createElement("div");
    const preview = createPreview(container, view, {
      katex: () => Promise.reject(new Error("offline")),
      diagrams: () => Promise.reject(new Error("offline")),
    });
    preview.show();
    await preview.settled();

    expect(container.querySelector(".math")?.textContent).toBe("x");
    expect(container.querySelector(".mermaid pre")?.textContent).toBe("A\n");
  });

  test("keeps a diagram's source, without an error, when its type fails to load; draws it next time", async () => {
    const pele = fakePele();
    const draw = pele.module.render;
    let offline = true;
    pele.module.render = (source, given) =>
      offline ? Promise.reject(new Error("offline")) : draw(source, given);
    const { container, preview, type } = setUp("```mermaid\nA\n```\n", pele);
    preview.show();
    await preview.settled();

    expect(container.querySelector(".mermaid .render-error")).toBeNull();
    expect(container.querySelector(".mermaid pre")?.textContent).toBe("A\n");

    offline = false;
    type("more");
    vi.runAllTimers();
    await preview.settled();
    expect(container.querySelector(".mermaid svg")).not.toBeNull();
  });

  test("does not retry a diagram that failed while its source is unchanged", async () => {
    const pele = fakePele(() => true);
    const { container, preview, type } = setUp("```mermaid\nbad\n```\n", pele);
    preview.show();
    await preview.settled();

    type("more text");
    vi.runAllTimers();
    await preview.settled();

    expect(pele.rendered).toEqual(["bad\n"]);
    expect(container.querySelector(".mermaid .render-error")).not.toBeNull();
  });

  test("forgets the formulas and diagrams the text no longer has", async () => {
    const pele = fakePele();
    const { view, preview } = setUp("$a$\n```mermaid\nA\n```", pele);
    const replace = (text: string) =>
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
      });
    preview.show();
    await preview.settled();

    replace("$b$\n```mermaid\nB\n```");
    vi.runAllTimers();
    await preview.settled();
    replace("$a$\n```mermaid\nA\n```");
    vi.runAllTimers();
    await preview.settled();

    expect(counter("katex.render")).toBe(3);
    expect(pele.rendered).toEqual(["A\n", "B\n", "A\n"]);
  });

  test("scrolls to an in-document anchor without touching the fragment, which holds the key", () => {
    const { container, preview } = setUp(
      "note[^1]\n\n[^1]: the note\n\n[out](https://e.org) [bad](#%E0)",
    );
    document.body.append(container);
    window.location.hash = "#k=key&s=secret";
    preview.show();
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.id);
    };

    const click = (link: Element | null) => {
      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      });
      link?.dispatchEvent(event);
      return event.defaultPrevented;
    };

    expect(click(container.querySelector('a[href="#fn-md-1"]'))).toBe(true);
    expect(scrolled).toEqual(["fn-md-1"]);
    expect(window.location.hash).toBe("#k=key&s=secret");
    expect(click(container.querySelector('a[href="https://e.org"]'))).toBe(
      false,
    );
    expect(click(container.querySelector('a[href="#%E0"]'))).toBe(true);
    container.remove();
  });

  test("an anchor without an element of its id goes to the view, decoded, the fragment untouched (phase 19, decision 8)", () => {
    const { container, preview } = setUp(
      "note[^1]\n\n## Mon titre\n\n[a](#Mon%20titre) [b](#fn-md-1) [c](#%E0)\n\n[^1]: the note",
    );
    document.body.append(container);
    window.location.hash = "#k=key&s=secret";
    preview.show();
    const asked: string[] = [];
    preview.onAnchor((id) => {
      asked.push(id);
    });
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.id);
    };
    const click = (href: string) => {
      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      });
      container.querySelector(`a[href="${href}"]`)?.dispatchEvent(event);
      return event.defaultPrevented;
    };

    expect(click("#Mon%20titre")).toBe(true);
    expect(click("#fn-md-1")).toBe(true);
    expect(click("#%E0")).toBe(true);
    expect(asked).toEqual(["Mon titre", "%E0"]);
    expect(scrolled).toEqual(["fn-md-1"]);
    expect(window.location.hash).toBe("#k=key&s=secret");
    container.remove();
  });

  test("a [[…]] to a heading goes to the view; one to a note says it is not shared (phase 19)", () => {
    const { container, preview } = setUp("[[#P#E|là]] et [[Note]]");
    document.body.append(container);
    preview.show();
    vi.runAllTimers();
    const asked: string[] = [];
    preview.onAnchor((id) => {
      asked.push(id);
    });
    container.querySelector<HTMLElement>("a.md-wikilink")?.click();
    expect(asked).toEqual(["P#E"]);
    const local = container.querySelector(".md-wikilink-local");
    expect(local?.getAttribute("title")).toBe(t().wikilinkLocal);
    container.remove();
  });

  test("keeps the blocks that did not change, their diagrams and formulas untouched", async () => {
    const { view, container, preview } = setUp(
      "first\n\n```mermaid\nA\n```\n\n$$x$$\n\nlast",
    );
    preview.show();
    await preview.settled();
    const diagram = container.querySelector(".mermaid svg");
    const formula = container.querySelector(".math .katex");
    const last = container.querySelector(".preview > p:last-child");

    view.dispatch({ changes: { from: 0, insert: "new top\n\n" } });
    view.dispatch({
      changes: { from: view.state.doc.length - 4, insert: "the " },
    });
    vi.runAllTimers();
    await preview.settled();

    expect(container.querySelector(".mermaid svg")).toBe(diagram);
    expect(container.querySelector(".math .katex")).toBe(formula);
    expect(container.querySelector(".preview > p:last-child")).not.toBe(last);
    expect(
      container.querySelector(".preview > p:last-child")?.textContent,
    ).toBe("the last");
    expect(container.querySelector(".preview > p")?.textContent).toBe(
      "new top",
    );
    expect(counter("katex.render")).toBe(1);
  });
});
