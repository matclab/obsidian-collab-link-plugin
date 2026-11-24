// Live formatting (phase 11, decisions 3 and 5): which markup is hidden,
// from the syntax tree, the selection and the part on screen — a pure
// function, no DOM. The styles are the highlighter's (markdown-syntax.ts).

import { markdown } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { Strikethrough, Table, TaskList } from "@lezer/markdown";
import { describe, expect, test } from "vitest";
import { counter } from "../perf/index.js";
import { highlightExtension } from "./highlight-syntax.js";
import { type LiveSpec, livePreview } from "./live-preview.js";
import type { Reveal } from "./live-reveal.js";
import { markdownSyntax } from "./markdown-syntax.js";
import { mathExtension } from "./math-syntax.js";

function specsOf(
  text: string,
  selection: { from: number; to: number }[] = [],
  visible = [{ from: 0, to: text.length }],
  reveal: Reveal[] = [],
): LiveSpec[] {
  const state = EditorState.create({
    doc: text,
    extensions: [
      markdown({
        extensions: [
          Table,
          Strikethrough,
          TaskList,
          mathExtension,
          highlightExtension,
        ],
      }),
    ],
  });
  const tree = ensureSyntaxTree(state, text.length, 5000);
  if (!tree) throw new Error("not parsed");
  return livePreview(tree, state.doc, selection, visible, reveal);
}

/** The text as shown: the document without what is hidden. */
function shown(text: string, specs: LiveSpec[]): string {
  let out = "";
  let at = 0;
  for (const spec of specs) {
    if (spec.kind !== "hide" && spec.kind !== "widget") continue;
    out += text.slice(at, Math.max(at, spec.from));
    if (spec.kind === "widget")
      out +=
        spec.widget === "bullet"
          ? "• "
          : spec.widget === "task"
            ? spec.checked
              ? "☑ "
              : "☐ "
            : `⟨${spec.widget}⟩`;
    at = Math.max(at, spec.to);
  }
  return out + text.slice(at);
}

function lines(text: string, specs: LiveSpec[]): [number, string][] {
  const starts = [0];
  for (let i = 0; i < text.length; i++)
    if (text[i] === "\n") starts.push(i + 1);
  return specs
    .filter((spec) => spec.kind === "line")
    .map((spec) => [starts.indexOf(spec.from) + 1, spec.className ?? ""]);
}

function marked(text: string, specs: LiveSpec[], className: string): string[] {
  return specs
    .filter((spec) => spec.kind === "mark" && spec.className === className)
    .map((spec) => text.slice(spec.from, spec.to));
}

describe("livePreview", () => {
  test("hides the markup of emphasis, strong, code and strikethrough", () => {
    const text = "Du **gras**, *it*, _it_, `code` et ~~barré~~.";
    expect(shown(text, specsOf(text))).toBe("Du gras, it, it, code et barré.");
  });

  // ADR-0044: the marks and a color's emoji hidden, the text colored.
  test("a highlight shows its text, in the color its emoji names", () => {
    const text = "Un ==🟢fait==, un ==*point*== et ==⚫autre==.";
    const specs = specsOf(text);
    expect(shown(text, specs)).toBe("Un fait, un point et ⚫autre.");
    expect(marked(text, specs, "cm-md-highlight-green")).toEqual(["fait"]);
    // Revealed on the caret's line: written as it is, still colored.
    const near = specsOf(text, [{ from: 0, to: 0 }]);
    expect(shown(text, near)).toBe(text);
    expect(marked(text, near, "cm-md-highlight-green")).toEqual(["fait"]);
  });

  // Found by the visible-text property (2026-10-23, during phase 19, not
  // about it): three `=` then a color's emoji and `==`. The preview shows
  // it all as text; the editor read a highlight of nothing and hid it.
  test("`a===🔴==` is text, as in the preview; an odd `=` stays shown", () => {
    const text = "p a===🔴==";
    expect(shown(text, specsOf(text))).toBe("p a===🔴==");
    expect(shown("p ===a== b", specsOf("p ===a== b"))).toBe("p =a b");
    expect(shown("p ==a=== b", specsOf("p ==a=== b"))).toBe("p a= b");
  });

  test("a code span loses one space each side, as CommonMark says", () => {
    const text = "a `` `x` `` b ` ` c";
    expect(shown(text, specsOf(text))).toBe("a `x` b   c");
  });

  // Found by the visible-text property (2026-10-23, phase 19a, once its
  // generator had `!`): a reference image, `![x]`, has no address; its
  // text is formatted as a reference link's, its brackets kept.
  test("an image without an address: its brackets kept, its text formatted", () => {
    const text = "p ![` a `]] et ![`b` *c*] d";
    expect(shown(text, specsOf(text))).toBe("p ![a]] et ![b c] d");
  });

  test("a link shows its text only, underlined; an autolink its address", () => {
    const text = 'Voir [le *site*](https://x.org "titre") ou <https://y.org>.';
    const specs = specsOf(text);
    expect(shown(text, specs)).toBe("Voir le site ou https://y.org.");
    expect(marked(text, specs, "cm-live-link")).toEqual([
      "le *site*",
      "https://y.org",
    ]);
  });

  test("a reference link stays as written", () => {
    const text = "Un [lien][ref] ou [ref].";
    expect(shown(text, specsOf(text))).toBe(text);
  });

  test("a reference link keeps its brackets, its text is formatted", () => {
    const text = "Un [\\*a\\*] ou [**b**].";
    expect(shown(text, specsOf(text))).toBe("Un [*a*] ou [b].");
  });

  test("a formula or a drawn image over a line break stays its source: a plugin may not replace one", () => {
    const text = "Z$$\nx^2\n$$ et $a\nb$";
    expect(shown(text, specsOf(text))).toBe(text);
    const image = "![a\nb](data:image/png;base64,AAAA)";
    expect(specsOf(image).some((spec) => spec.kind === "widget")).toBe(false);
  });

  test("a code block in a list in a quote: its lines lose their quote markers, as the item's lines", () => {
    const text = "> - a\n>\n>   ```\n>   x\n>   ```\n>\n>       indenté";
    expect(shown(text, specsOf(text))).toBe("• a\n\n```\nx\n```\n\nindenté");
  });

  test("a hard break's backslash is hidden, as in the preview; shown on its line", () => {
    const text = "un\\\ndeux  \ntrois";
    expect(shown(text, specsOf(text))).toBe("un\ndeux  \ntrois");
    expect(shown(text, specsOf(text, [{ from: 1, to: 1 }]))).toBe(text);
  });

  test("an escape shows the character, as the preview does", () => {
    const text = "Un \\*astérisque\\*.";
    expect(shown(text, specsOf(text))).toBe("Un *astérisque*.");
  });

  test("for a screen reader, what the hidden markup said: a heading, a quote, a link (11e.2)", () => {
    const text =
      "# Titre\n\nSous\n---\n\n> Citée\n> encore\n\nUn [lien](https://x.org) et <https://y.org>.";
    const said = livePreview(
      ...((): Parameters<typeof livePreview> => {
        const state = EditorState.create({
          doc: text,
          extensions: [
            markdown({
              extensions: [Table, Strikethrough, TaskList, mathExtension],
            }),
          ],
        });
        const tree = ensureSyntaxTree(state, text.length, 5000);
        if (!tree) throw new Error("not parsed");
        return [tree, state.doc, [], [{ from: 0, to: text.length }]];
      })(),
    )
      .filter((spec) => spec.attributes)
      .map((spec) => [
        text.slice(
          spec.from,
          spec.kind === "line" ? text.indexOf("\n", spec.from) : spec.to,
        ),
        spec.attributes,
      ]);
    expect(said).toEqual([
      ["# Titre", { role: "heading", "aria-level": "1" }],
      ["Sous", { role: "heading", "aria-level": "2" }],
      ["> Citée", { role: "group", "aria-roledescription": "Quote" }],
      ["> encore", { role: "group", "aria-roledescription": "Quote" }],
      ["lien", { role: "link" }],
      ["https://y.org", { role: "link" }],
    ]);
  });

  test("a heading hides its marks and styles its line by level", () => {
    const text = "# Titre #\n\n### Sous *titre*";
    const specs = specsOf(text);
    expect(shown(text, specs)).toBe("Titre\n\nSous titre");
    expect(
      specs
        .filter((spec) => spec.kind === "line")
        .map((spec) => [spec.from, spec.className]),
    ).toEqual([
      [0, "cm-live-h1"],
      [11, "cm-live-h3"],
    ]);
  });

  test("the lines the selection touches show their markup", () => {
    const text = "**un**\n**deux**\n**trois**\n**quatre**";
    expect(shown(text, specsOf(text, [{ from: 9, to: 9 }]))).toBe(
      "un\n**deux**\ntrois\nquatre",
    );
    // A range over lines two to three touches both.
    expect(shown(text, specsOf(text, [{ from: 10, to: 18 }]))).toBe(
      "un\n**deux**\n**trois**\nquatre",
    );
  });

  test("a caret at the end of a line touches it", () => {
    const text = "**un**\n**deux**";
    expect(shown(text, specsOf(text, [{ from: 6, to: 6 }]))).toBe(
      "**un**\ndeux",
    );
  });

  test("nothing outside the part on screen", () => {
    const text = "**un**\n\n**deux**";
    const specs = specsOf(text, [], [{ from: 8, to: text.length }]);
    expect(specs.every((spec) => spec.from >= 8)).toBe(true);
    expect(shown(text, specs)).toBe("**un**\n\ndeux");
  });

  test("specs come sorted, as a RangeSet wants them", () => {
    const text = "# *a* [b](c)\n\n**d** `e`";
    const specs = specsOf(text);
    for (let i = 1; i < specs.length; i++) {
      expect((specs[i - 1] as LiveSpec).from).toBeLessThanOrEqual(
        (specs[i] as LiveSpec).from,
      );
    }
  });

  test("the work is the part on screen's, whatever the document's length", () => {
    const paragraphs = (n: number) =>
      Array.from({ length: n }, (_, i) => `Le **${i}** et [l](u) *x*.`).join(
        "\n\n",
      );
    const visible = [{ from: 0, to: 600 }];
    const work = (text: string) => {
      const before = counter("live.node");
      specsOf(text, [], visible);
      return counter("live.node") - before;
    };
    const small = work(paragraphs(200));
    expect(small).toBeGreaterThan(0);
    expect(work(paragraphs(800))).toBe(small);
  });
});

describe("livePreview, blocks", () => {
  test("headings: every ATX level; a Setext heading's text, and its underline dimmed", () => {
    const text = "#### a\n##### b\n###### c\n\nTitre\n===\n\nSous\n---";
    const specs = specsOf(text);
    expect(lines(text, specs)).toEqual([
      [1, "cm-live-h4"],
      [2, "cm-live-h5"],
      [3, "cm-live-h6"],
      [5, "cm-live-h1"],
      [6, "cm-live-markup-line"],
      [8, "cm-live-h2"],
      [9, "cm-live-markup-line"],
    ]);
    // A whole line of markup is not hidden: a plugin cannot take a line.
    expect(shown(text, specs)).toBe("a\nb\nc\n\nTitre\n===\n\nSous\n---");
  });

  test("a bullet becomes a dot; a number stays", () => {
    const text = "- un\n  * sous\n1. a\n2) b";
    expect(shown(text, specsOf(text))).toBe("• un\n• sous\n1. a\n2) b");
  });

  test("a list item hangs under its text, by its depth; its other lines too", () => {
    const text = "- un\n  - sous\n    suite\n1. a\nlazy\n10. b";
    const specs = specsOf(text);
    expect(
      specs
        .filter((spec) => spec.kind === "line")
        .map((spec) => [spec.className, spec.style]),
    ).toEqual([
      ["cm-live-li", "--li-depth: 0"],
      ["cm-live-li", "--li-depth: 1"],
      ["cm-live-li-cont", "--li-depth: 1"],
      ["cm-live-li", "--li-depth: 0"],
      ["cm-live-li-cont", "--li-depth: 0"],
      ["cm-live-li", "--li-depth: 0"],
    ]);
    // The indentation is the line's, not spaces.
    expect(shown(text, specs)).toBe("• un\n• sous\nsuite\n1. a\nlazy\n10. b");
    // A number keeps its text, in a marker of its own width.
    expect(marked(text, specs, "cm-live-num")).toEqual(["1. ", "10. "]);
  });

  test("a list in a quote hangs like any other: the spaces after `>` hidden too", () => {
    const text = "> - a\n>   - b\n>     suite";
    const specs = specsOf(text);
    expect(shown(text, specs)).toBe("• a\n• b\nsuite");
    expect(
      specs
        .filter((spec) => spec.kind === "line")
        .map((spec) => [spec.from, spec.className, spec.style]),
    ).toEqual([
      [0, "cm-live-quote", undefined],
      [0, "cm-live-li", "--li-depth: 0"],
      [6, "cm-live-quote", undefined],
      [6, "cm-live-li", "--li-depth: 1"],
      [14, "cm-live-quote", undefined],
      [14, "cm-live-li-cont", "--li-depth: 1"],
    ]);
  });

  test("a touched list line is its source: no hanging, nothing hidden", () => {
    const text = "- un\n  - sous";
    const specs = specsOf(text, [{ from: 8, to: 8 }]);
    expect(shown(text, specs)).toBe("• un\n  - sous");
    expect(
      specs.filter((spec) => spec.kind === "line").map((spec) => spec.from),
    ).toEqual([0]);
  });

  test("a touched list line keeps its indentation, as wide as its bullets' (ADR-0054)", () => {
    // Its marker where the line's bullet stands, by tabs or spaces: the
    // indentation shown, in a box of the depth's width.
    const text = "- un\n\t- deux\n\t\t- trois\n\t\t  suite\n- quatre";
    const at = (word: string) => {
      const from = text.indexOf(word);
      return [{ from, to: from }];
    };
    const indents = (specs: LiveSpec[]) =>
      specs
        .filter(
          (spec) =>
            spec.kind === "mark" && /li-indent/.test(spec.className ?? ""),
        )
        .map((spec) => [
          text.slice(spec.from, spec.to),
          spec.className,
          spec.attributes?.style,
        ]);
    expect(indents(specsOf(text, at("trois")))).toEqual([
      ["\t\t", "cm-live-li-indent", "--li-depth: 2"],
    ]);
    expect(indents(specsOf(text, at("suite")))).toEqual([
      ["\t\t  ", "cm-live-li-indent-cont", "--li-depth: 2"],
    ]);
    // Nothing to box at the first level; nothing hidden all the same.
    expect(indents(specsOf(text, at("quatre")))).toEqual([]);
    expect(shown(text, specsOf(text, at("trois")))).toContain("\t\t- trois");
  });

  test("a task's marker becomes a box, checked or not", () => {
    const text = "- [ ] faire\n- [x] fait\n- [X] fait aussi";
    const specs = specsOf(text);
    expect(shown(text, specs)).toBe("☐ faire\n☑ fait\n☑ fait aussi");
    const boxes = specs.filter((spec) => spec.widget === "task");
    expect(
      boxes.map((box) => [text.slice(box.from, box.to), box.checked]),
    ).toEqual([
      ["[ ] ", false],
      ["[x] ", true],
      ["[X] ", true],
    ]);
    // A task's bullet goes: the box is enough. The box takes its space in.
    expect(specs.filter((spec) => spec.widget === "bullet")).toEqual([]);
    expect(
      specs
        .filter((spec) => spec.kind === "hide")
        .map((spec) => text.slice(spec.from, spec.to)),
    ).toEqual(["- ", "- ", "- "]);
  });

  test("a quote hides its marks and draws its lines, nested or lazy", () => {
    const text = "> un\n> > deux\ntrois";
    const specs = specsOf(text);
    expect(shown(text, specs)).toBe("un\ndeux\ntrois");
    expect(lines(text, specs)).toEqual([
      [1, "cm-live-quote"],
      [2, "cm-live-quote"],
      [3, "cm-live-quote"],
    ]);
  });

  test("a rule is a line drawn, its characters hidden", () => {
    const text = "a\n\n***\n\nb";
    const specs = specsOf(text);
    expect(shown(text, specs)).toBe("a\n\n\n\nb");
    expect(lines(text, specs)).toEqual([[3, "cm-live-hr"]]);
  });

  test("a code block: its lines on a background, its fences dimmed, nothing hidden", () => {
    const text = "```js\nconst **a** = 1;\n```\n\n    indented";
    const specs = specsOf(text);
    expect(shown(text, specs)).toBe(text);
    expect(lines(text, specs)).toEqual([
      [1, "cm-live-codeblock cm-live-fence"],
      [2, "cm-live-codeblock"],
      [3, "cm-live-codeblock cm-live-fence"],
      [5, "cm-live-codeblock"],
    ]);
  });

  test("a touched line shows its block markup, still drawn as its block", () => {
    const text = "- [ ] a\n> b\n---\n- c";
    const caretOn = (line: number) => {
      const at =
        text
          .split("\n")
          .slice(0, line - 1)
          .join("\n").length + (line > 1 ? 1 : 0);
      return specsOf(text, [{ from: at, to: at }]);
    };
    expect(shown(text, caretOn(1))).toBe("- [ ] a\nb\n\n• c");
    expect(shown(text, caretOn(2))).toBe("☐ a\n> b\n\n• c");
    expect(shown(text, caretOn(3))).toBe("☐ a\nb\n---\n• c");
    expect(shown(text, caretOn(4))).toBe("☐ a\nb\n\n- c");
    expect(lines(text, caretOn(2))).toContainEqual([2, "cm-live-quote"]);
  });
});

describe("livePreview, inline widgets", () => {
  const widgets = (specs: LiveSpec[]) =>
    specs
      .filter((spec) => spec.kind === "widget")
      .map(({ widget, source, display, alt }) => ({
        widget,
        source,
        ...(display !== undefined && { display }),
        ...(alt !== undefined && { alt }),
      }));

  test("a formula becomes its rendering, inline or displayed", () => {
    const text = "Soit $x^2$ et $$\\sum_i i$$.";
    const specs = specsOf(text);
    expect(widgets(specs)).toEqual([
      { widget: "math", source: "x^2", display: false },
      { widget: "math", source: "\\sum_i i", display: true },
    ]);
    expect(shown(text, specs)).toBe("Soit ⟨math⟩ et ⟨math⟩.");
  });

  test("on a touched line, a formula is its source", () => {
    const text = "$x$\n$y$";
    expect(shown(text, specsOf(text, [{ from: 0, to: 0 }]))).toBe(
      "$x$\n⟨math⟩",
    );
  });

  test("an embedded image is drawn; any other is its text as a link, as in the preview", () => {
    const png = "data:image/png;base64,AAAA";
    const text = `![logo](${png}) ![carte](https://x.org/a.png) ![svg](data:image/svg+xml,<svg/>) ![](https://x.org/b.png)`;
    const specs = specsOf(text);
    expect(widgets(specs)).toEqual([
      { widget: "image", source: png, alt: "logo" },
    ]);
    expect(shown(text, specs)).toBe(
      "⟨image⟩ carte svg ![](https://x.org/b.png)",
    );
    expect(marked(text, specs, "cm-live-link")).toEqual(["carte", "svg"]);
  });

  describe("what other layers keep in sight (phase 11e)", () => {
    const LINK = 'Un [lien](https://x.org "t").\nDu **gras**.';
    const at = (text: string, needle: string) => text.indexOf(needle);
    const reveal = (
      text: string,
      from: number,
      to: number,
      kind: Reveal["kind"] = "annotation",
    ) => shown(text, specsOf(text, [], undefined, [{ from, to, kind }]));

    test("a point in hidden markup (a proposal in a link's address) reveals its line, only it", () => {
      const p = at(LINK, "org");
      expect(reveal(LINK, p, p)).toBe(
        'Un [lien](https://x.org "t").\nDu gras.',
      );
    });

    test("a remote caret there too; a caret in a formula drawn", () => {
      const p = at(LINK, "x.org");
      expect(reveal(LINK, p, p, "cursor")).toBe(
        'Un [lien](https://x.org "t").\nDu gras.',
      );
      const text = "Soit $x+y$ ici.\n**b**";
      const q = at(text, "+");
      expect(reveal(text, q, q, "cursor")).toBe("Soit $x+y$ ici.\nb");
    });

    test("a passage all hidden reveals its line; one partly shown does not", () => {
      expect(reveal(LINK, at(LINK, "x.org"), at(LINK, "x.org") + 5)).toBe(
        'Un [lien](https://x.org "t").\nDu gras.',
      );
      expect(reveal(LINK, at(LINK, "lien"), at(LINK, "https") + 5)).toBe(
        "Un lien.\nDu gras.",
      );
    });

    test("a point at the edge of hidden markup, or on shown text, reveals nothing", () => {
      for (const p of [at(LINK, ")") + 1, at(LINK, "Un"), at(LINK, "ien")]) {
        expect(reveal(LINK, p, p)).toBe("Un lien.\nDu gras.");
      }
    });

    test("the active passage reveals its lines, shown or not, without focus", () => {
      expect(
        reveal(LINK, at(LINK, "gras"), at(LINK, "gras") + 4, "active"),
      ).toBe("Un lien.\nDu **gras**.");
    });

    test("off screen, nothing is looked at", () => {
      const p = at(LINK, "org");
      const specs = specsOf(
        LINK,
        [],
        [{ from: at(LINK, "Du"), to: LINK.length }],
        [{ from: p, to: p, kind: "annotation" }],
      );
      expect(specs.every((spec) => spec.from >= at(LINK, "Du"))).toBe(true);
    });
  });
});

describe("livePreview, callouts (phase 15)", () => {
  /** On the editor's own parser, which marks a callout's header. */
  function calloutSpecs(
    text: string,
    selection: { from: number; to: number }[] = [],
    reveal: Reveal[] = [],
  ): LiveSpec[] {
    const state = EditorState.create({
      doc: text,
      extensions: [markdownSyntax()],
    });
    const tree = ensureSyntaxTree(state, text.length, 5000);
    if (!tree) throw new Error("not parsed");
    return livePreview(
      tree,
      state.doc,
      selection,
      [{ from: 0, to: text.length }],
      reveal,
    );
  }
  const lineSpecs = (text: string, specs: LiveSpec[]) =>
    lines(text, specs).filter(([, name]) => /callout|quote/.test(name));

  test("its lines in its colour, its title line apart, its header its icon", () => {
    const text = "> [!warning]- Titre *beau*\n> contenu";
    const specs = calloutSpecs(text);
    expect(shown(text, specs)).toBe("⟨callout-header⟩Titre beau\ncontenu");
    const header = specs.find((spec) => spec.widget === "callout-header");
    expect([header?.family, header?.source]).toEqual(["warning", ""]);
    expect(text.slice(header?.from, header?.to)).toBe("[!warning]- ");
    expect(lineSpecs(text, specs)).toEqual([
      [1, "cm-live-callout cm-live-callout-title"],
      [2, "cm-live-callout"],
    ]);
    const first = specs.find((spec) => spec.kind === "line");
    expect(first?.style).toBe("--md-callout-color: var(--md-callout-warning)");
    expect(first?.attributes).toEqual({
      role: "group",
      "aria-roledescription": "Callout",
    });
  });

  test("an alias takes its family's colour; an unknown type, note's", () => {
    const style = (text: string) =>
      calloutSpecs(text).find((spec) => spec.kind === "line")?.style;
    expect(style("> [!faq] x")).toBe(
      "--md-callout-color: var(--md-callout-question)",
    );
    expect(style("> [!Mon Type] x")).toBe(
      "--md-callout-color: var(--md-callout-note)",
    );
  });

  test("without a title, its icon and its default one in place of the header", () => {
    const text = "> [!foo-bar]+\n> x";
    const specs = calloutSpecs(text);
    expect(shown(text, specs)).toBe("⟨callout-header⟩\nx");
    const header = specs.find((spec) => spec.widget === "callout-header");
    expect([header?.family, header?.source]).toEqual(["note", "Foo bar"]);
  });

  test("its header shown on a line the selection touches", () => {
    const text = "> [!note] T\n> body";
    const specs = calloutSpecs(text, [{ from: 5, to: 5 }]);
    expect(shown(text, specs)).toBe("> [!note] T\nbody");
    expect(lineSpecs(text, specs)).toEqual([
      [1, "cm-live-callout cm-live-callout-title"],
      [2, "cm-live-callout"],
    ]);
  });

  test("an annotation or a remote caret in its header reveals the header's line, only it", () => {
    const text = "> [!warning]- T\n> **body**";
    const p = text.indexOf("warning") + 2;
    for (const kind of ["annotation", "cursor"] as const) {
      const specs = calloutSpecs(text, [], [{ from: p, to: p, kind }]);
      expect(shown(text, specs)).toBe("> [!warning]- T\nbody");
      expect(lineSpecs(text, specs)).toEqual([
        [1, "cm-live-callout cm-live-callout-title"],
        [2, "cm-live-callout"],
      ]);
    }
  });

  test("the active annotation in its content reveals that line; the header stays hidden", () => {
    const text = "> [!warning] T\n> **body**";
    const from = text.indexOf("body");
    const specs = calloutSpecs(
      text,
      [],
      [{ from, to: from + 4, kind: "active" }],
    );
    expect(shown(text, specs)).toBe("⟨callout-header⟩T\n> **body**");
  });

  test("the type's own markup hidden with the header, never twice", () => {
    const text = "> [!*a*] T";
    const specs = calloutSpecs(text);
    expect(shown(text, specs)).toBe("⟨callout-header⟩T");
    const hides = specs.filter((spec) => spec.kind !== "line");
    expect(hides).toHaveLength(2); // the `>` and the header
  });

  test("its title is its line: markup across the line's end stays as written, as in the preview", () => {
    const link = "> [!note] [t](\n> u)";
    expect(shown(link, calloutSpecs(link))).toBe("⟨callout-header⟩[t](\nu)");
    const emphasis = "> [!note] *a `c`\n> b*";
    expect(shown(emphasis, calloutSpecs(emphasis))).toBe(
      "⟨callout-header⟩*a c\nb*",
    );
    // Within the title line, as anywhere.
    const inside = "> [!note] *a*\n> b";
    expect(shown(inside, calloutSpecs(inside))).toBe("⟨callout-header⟩a\nb");
  });

  // Found by the block-start property (2026-10-16, « Défauts connus »):
  // the preview reads the title and the content apart; markup across the
  // title line's end was shown as written, but the content was not read
  // again on its own (`u)_*_`: an emphasis of `*`).
  test("its content is read on its own, as the preview reads it", () => {
    const text = "> [!note] *[t](\nu)_*_";
    expect(shown(text, calloutSpecs(text))).toBe("⟨callout-header⟩*[t](\nu)*");
    const quoted = "> [!note] **a\n> b** *c*";
    expect(shown(quoted, calloutSpecs(quoted))).toBe(
      "⟨callout-header⟩**a\nb** c",
    );
  });

  test("not a callout: a quote, its header as text", () => {
    for (const text of [
      ">  [!note] deux",
      "> x\n> [!note] y",
      "> # [!note]",
      // Not on the quote's first line, as in Obsidian (essai 15e.2).
      ">\n> [!note] y",
      "> >\n> > [!note] y",
    ]) {
      const specs = calloutSpecs(text);
      expect(
        lineSpecs(text, specs).every(([, name]) => name === "cm-live-quote"),
        text,
      ).toBe(true);
      expect(shown(text, specs)).toContain("[!note]");
    }
  });

  test("nested: a line in the innermost callout's frame; a quote in a callout keeps its rule", () => {
    const nested = "> [!note] A\n> > [!tip] B\n> > x";
    expect(lineSpecs(nested, calloutSpecs(nested))).toEqual([
      [1, "cm-live-callout cm-live-callout-title"],
      [2, "cm-live-callout cm-live-callout-title"],
      [3, "cm-live-callout"],
    ]);
    const styles = calloutSpecs(nested)
      .filter((spec) => spec.kind === "line")
      .map((spec) => spec.style);
    expect(styles).toEqual([
      "--md-callout-color: var(--md-callout-note)",
      "--md-callout-color: var(--md-callout-tip)",
      "--md-callout-color: var(--md-callout-tip)",
    ]);
    const quoted = "> [!note] A\n> > q";
    expect(lineSpecs(quoted, calloutSpecs(quoted))).toEqual([
      [1, "cm-live-callout cm-live-callout-title"],
      [2, "cm-live-callout"],
      [2, "cm-live-quote"],
    ]);
    const inQuote = "> > [!tip] B\n> > x";
    expect(lineSpecs(inQuote, calloutSpecs(inQuote))).toEqual([
      [1, "cm-live-callout cm-live-callout-title"],
      [2, "cm-live-callout"],
    ]);
  });
});
