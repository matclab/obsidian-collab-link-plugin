import { describe, expect, test } from "vitest";
import { counter, resetCounters } from "../perf/index.js";
import { CALLOUT_FOLD_ICON, calloutIcon } from "./callout-icons.js";
import {
  leavingHref,
  remoteImageSources,
  renderMarkdown as render,
} from "./render.js";

describe("renderMarkdown", () => {
  test("renders CommonMark emphasis in a paragraph", () => {
    expect(render("some *emphasis* and **strong**")).toBe(
      "<p>some <em>emphasis</em> and <strong>strong</strong></p>\n",
    );
  });

  test("escapes raw HTML instead of rendering it", () => {
    expect(render('<img src=x onerror="alert(1)">')).toBe(
      "<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>\n",
    );
  });

  test("renders GFM tables with alignment and strikethrough", () => {
    expect(render("| a | b |\n|---|--:|\n| ~~x~~ | 2 |")).toBe(
      '<table>\n<thead>\n<tr>\n<th>a</th>\n<th style="text-align:right">b</th>\n</tr>\n</thead>\n' +
        '<tbody>\n<tr>\n<td><s>x</s></td>\n<td style="text-align:right">2</td>\n</tr>\n</tbody>\n</table>\n',
    );
  });

  // The editor's parser reads a table on lazy lines (phase 24); so does
  // the preview, never their text.
  describe("a table on an item's or a quote's lazy lines", () => {
    const flat = (source: string) =>
      render(source)
        .replace(/\n/g, "")
        .replace(/<t[hd]>[^<]*<\/t[hd]>|<\/?(thead|tbody|tr)>/g, "");

    test("its header line ends the item or the quote", () => {
      expect(flat("- item\n| a | b |\n|---|---|")).toBe(
        "<ul><li>item</li></ul><table></table>",
      );
      expect(flat("- item\nPara a\n| a | b |\n|---|---|\n| c | d |")).toBe(
        "<ul><li>itemPara a</li></ul><table></table>",
      );
      expect(flat("> q\n| a | b |\n|---|---|")).toBe(
        "<blockquote><p>q</p></blockquote><table></table>",
      );
      expect(flat("> - item\n| a | b |\n|---|---|")).toBe(
        "<blockquote><ul><li>item</li></ul></blockquote><table></table>",
      );
    });

    test("in a nested item or quote, the outer one keeps it", () => {
      expect(flat("- a\n  - b\n  | x | y |\n  |---|---|")).toBe(
        "<ul><li>a<ul><li>b</li></ul><table></table></li></ul>",
      );
      expect(flat("> > q\n> | a | b |\n> |---|---|")).toBe(
        "<blockquote><blockquote><p>q</p></blockquote><table></table></blockquote>",
      );
    });

    test("its other lines, lazy, stay in it", () => {
      expect(flat("- item\n  | a | b |\n|---|---|")).toBe(
        "<ul><li>item<table></table></li></ul>",
      );
      expect(flat("- item\n  | a | b |\n  |---|---|\n| c | d |")).toBe(
        "<ul><li>item<table></table></li></ul>",
      );
      expect(flat("> | a | b |\n|---|---|")).toBe(
        "<blockquote><table></table></blockquote>",
      );
      expect(flat("> | a | b |\n> |---|---|\n| c | d |")).toBe(
        "<blockquote><table></table></blockquote>",
      );
    });

    test("not as many columns: still the item's text", () => {
      expect(flat("- item\n| a |\n|---|---|")).toBe(
        "<ul><li>item| a ||---|---|</li></ul>",
      );
    });
  });

  // Obsidian's highlights (ADR-0044): `==` around, a color by one of six
  // emojis right after the opening, the emoji not shown.
  test("renders a highlight, in a color its leading emoji names", () => {
    expect(render("a ==b *c*== d")).toBe(
      "<p>a <mark>b <em>c</em></mark> d</p>\n",
    );
    for (const [emoji, color] of [
      ["🔴", "red"],
      ["🟠", "orange"],
      ["🟡", "yellow"],
      ["🟢", "green"],
      ["🔵", "blue"],
      ["🟣", "purple"],
    ]) {
      expect(render(`==${emoji}TODO== x`)).toBe(
        `<p><mark class="md-highlight-${color}">TODO</mark> x</p>\n`,
      );
    }
  });

  test("another emoji, or one not right after the opening, is text in the default color", () => {
    expect(render("==⚫x==")).toBe("<p><mark>⚫x</mark></p>\n");
    expect(render("== 🔴x==")).toBe("<p>== 🔴x==</p>\n");
    expect(render("==x🔴==")).toBe("<p><mark>x🔴</mark></p>\n");
    expect(render("==*🔴x*==")).toBe("<p><mark><em>🔴x</em></mark></p>\n");
    expect(render("🔴 a == b")).toBe("<p>🔴 a == b</p>\n");
    expect(render("`==x==`")).toBe("<p><code>==x==</code></p>\n");
  });

  test("renders task list items as read-only checkboxes, not greyed out, nested ones too", () => {
    expect(render("- [ ] todo\n- [x] done\n  - [X] nested")).toBe(
      '<ul>\n<li class="task-list-item"><input type="checkbox" aria-disabled="true" tabindex="-1"> todo</li>\n' +
        '<li class="task-list-item"><input type="checkbox" aria-disabled="true" tabindex="-1" checked> done\n<ul>\n' +
        '<li class="task-list-item"><input type="checkbox" aria-disabled="true" tabindex="-1" checked> nested</li>\n</ul>\n</li>\n</ul>\n',
    );
  });

  test("leaves brackets as text outside the start of a list item", () => {
    expect(render("[ ] not a task\n\n- a [x] b\n- [x]no space")).toBe(
      "<p>[ ] not a task</p>\n<ul>\n<li>a [x] b</li>\n<li>[x]no space</li>\n</ul>\n",
    );
  });

  test("renders footnotes, with ids prefixed apart from the page's", () => {
    const html = render("> quoted[^a]\n\n[^a]: the *note*");
    expect(html).toContain(
      '<blockquote>\n<p>quoted<sup class="footnote-ref"><a href="#fn-md-1" id="fnref-md-1">[1]</a></sup></p>\n</blockquote>',
    );
    expect(html).toContain(
      '<li id="fn-md-1" class="footnote-item"><p>the <em>note</em> <a href="#fnref-md-1" class="footnote-backref">',
    );
  });

  // Mist's limit, not to reproduce (PRD §4.1).
  test("nests lists and quotes to any depth", () => {
    const source = [
      "> - quoted item",
      ">   1. ordered",
      ">      > quote in list in quote",
      ">      > - [ ] task deep inside",
    ].join("\n");
    expect(render(source).replace(/\n/g, "")).toBe(
      "<blockquote><ul><li>quoted item<ol><li>ordered<blockquote>" +
        "<p>quote in list in quote</p>" +
        '<ul><li class="task-list-item"><input type="checkbox" aria-disabled="true" tabindex="-1"> task deep inside</li></ul>' +
        "</blockquote></li></ol></li></ul></blockquote>",
    );
  });

  test("turns inline and display formulas into placeholders carrying their source", () => {
    expect(render("mass $E=mc^2$ and $a<b$")).toBe(
      '<p>mass <span class="math" data-tex="E=mc^2">E=mc^2</span> and ' +
        '<span class="math" data-tex="a&lt;b">a&lt;b</span></p>\n',
    );
    expect(render("$$\n\\int_0^1 x\n$$")).toBe(
      '<div class="math math-display" data-tex="\n\\int_0^1 x\n">\n\\int_0^1 x\n</div>\n',
    );
  });

  test("numbers an equation with a KaTeX tag", () => {
    expect(render("$$x$$ (1)")).toBe(
      '<div class="math math-display" data-tex="x\\tag{1}">x\\tag{1}</div>\n',
    );
  });

  test("leaves dollar amounts as text (Pandoc rule)", () => {
    expect(render("Prix : 5 $ et 10 $, \\$3")).toBe(
      "<p>Prix : 5 $ et 10 $, $3</p>\n",
    );
  });

  test("a formula block in a quote, or in a list in a quote: its TeX without the quotes' markers", () => {
    const tex = (source: string) =>
      Array.from(
        render(source).matchAll(
          /<div class="math math-display" data-tex="([^"]*)"/g,
        ),
        (found) => found[1]?.trim(),
      );
    expect(tex("> $$\n> x\n> $$")).toEqual(["x"]);
    expect(tex("> - item\n>\n>   $$\n>   x\n>   $$")).toEqual(["x"]);
    expect(
      tex("> > - item\n> >\n> >   $$\n> >   a\n> >   b\n> >   $$"),
    ).toEqual(["a\n   b"]);
  });

  test("keeps formulas inside tables and footnotes", () => {
    const html = render("| f |\n|---|\n| $x^2$ |\n\nn[^1]\n\n[^1]: $y$");
    expect(html).toContain(
      '<td><span class="math" data-tex="x^2">x^2</span></td>',
    );
    expect(html).toContain(
      '<p><span class="math" data-tex="y">y</span> <a href="#fnref-md-1"',
    );
  });

  test("keeps a display formula within a paragraph as an inline element", () => {
    expect(render("see $$x$$ here")).toBe(
      '<p>see <span class="math math-display" data-tex="x">x</span> here</p>\n',
    );
  });

  test("turns a mermaid code block into a placeholder showing its source", () => {
    expect(render("```mermaid\ngraph TD\n  A-->B\n```")).toBe(
      '<div class="mermaid" data-source="graph TD\n  A--&gt;B\n">' +
        "<pre><code>graph TD\n  A--&gt;B\n</code></pre></div>\n",
    );
  });

  test("keeps other code blocks as code", () => {
    expect(render("```js\na<b\n```")).toBe(
      '<pre><code class="language-js">a&lt;b\n</code></pre>\n',
    );
  });

  test("opens links with a scheme in a new tab, without referrer or opener", () => {
    expect(render("[a](https://e.org/x) <https://auto.org>")).toBe(
      '<p><a href="https://e.org/x" target="_blank" rel="noopener noreferrer">a</a> ' +
        '<a href="https://auto.org" target="_blank" rel="noopener noreferrer">https://auto.org</a></p>\n',
    );
  });

  test("a link to another document, an address without a key: a new tab, which finds its link (phase 19, decision 5)", () => {
    expect(render("[B](https://collab.test/?doc=b#h=Partie%20un)")).toBe(
      '<p><a href="https://collab.test/?doc=b#h=Partie%20un" target="_blank" rel="noopener noreferrer">B</a></p>\n',
    );
    expect(leavingHref("https://collab.test/?doc=b#h=Partie%20un")).toBe(
      "https://collab.test/?doc=b#h=Partie%20un",
    );
  });

  test("opens a protocol-relative link in a new tab too: it leaves the document", () => {
    expect(render("[a](//e.org/x)")).toBe(
      '<p><a href="//e.org/x" target="_blank" rel="noopener noreferrer">a</a></p>\n',
    );
  });

  test("keeps in-document anchors as they are", () => {
    expect(render("[up](#top)")).toBe('<p><a href="#top">up</a></p>\n');
  });

  test("refuses script links, whatever their spelling", () => {
    for (const href of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "&#106;avascript:alert(1)",
      "javascript&colon;alert(1)",
      "<javascript:alert(1)>",
      "vbscript:x",
      "data:text/html,x",
    ]) {
      expect(render(`[a](${href})`)).not.toContain("<a");
    }
    expect(render("[r]\n\n[r]: javascript:alert(1)")).not.toContain("<a");
  });

  test("renders an image it may not load as a link", () => {
    expect(render("![a *pixel*](http://t.example/p.png)")).toBe(
      '<p><a class="remote-image" href="http://t.example/p.png" target="_blank" ' +
        'rel="noopener noreferrer">a pixel</a></p>\n',
    );
    expect(render("![a&b <c>](https://t.example/p.png)")).toContain(
      ">a&amp;b &lt;c&gt;</a>",
    );
    expect(render("![](img/p.png)")).toBe(
      '<p><a class="remote-image" href="img/p.png">img/p.png</a></p>\n',
    );
  });

  test("an image it may load, not granted: a case around its link (ADR-0055 §3)", () => {
    expect(render("![a *pixel*](https://t.example/p.png)", () => false)).toBe(
      '<p><span class="remote-image-case" data-image-source="https://t.example/p.png">' +
        '<a class="remote-image" href="https://t.example/p.png" target="_blank" ' +
        'rel="noopener noreferrer">a pixel</a></span></p>\n',
    );
  });

  test("an image granted: loaded, without a referrer, its domain to show (ADR-0055 §8, §13)", () => {
    const asked: string[] = [];
    const granted = (src: string) => {
      asked.push(src);
      return true;
    };
    expect(render("![a&b](https://T.example/p.png)", granted)).toBe(
      '<p><span class="remote-image-shown"><img src="https://t.example/p.png" alt="a&amp;b" referrerpolicy="no-referrer"></span></p>\n',
    );
    expect(asked).toEqual(["https://t.example/p.png"]);
  });

  test("an image is asked for with the source lines of its block (ADR-0055 §12)", () => {
    const asked: [string, readonly (readonly [number, number])[]][] = [];
    render(
      "# t\n\na ![x](https://t.example/1.png)\nb\n\n| c |\n| - |\n| ![y](https://t.example/2.png) |\n",
      (src, lines) => {
        asked.push([src, lines]);
        return false;
      },
    );
    expect(asked).toEqual([
      ["https://t.example/1.png", [[2, 4]]],
      ["https://t.example/2.png", [[7, 8]]],
    ]);
  });

  test("an image by reference, with its definition's lines too (ADR-0055 §12)", () => {
    const asked: [string, readonly (readonly [number, number])[]][] = [];
    render(
      "![x][r] and ![y](https://t.example/1.png)\n\ntext\n\n[r]: https://t.example/1.png\n[s]:\n  https://t.example/2.png\n\n![z][s]\n",
      (src, lines) => {
        asked.push([src, lines]);
        return false;
      },
    );
    expect(asked).toEqual([
      [
        "https://t.example/1.png",
        [
          [0, 1],
          [4, 5],
        ],
      ],
      [
        "https://t.example/1.png",
        [
          [0, 1],
          [4, 5],
        ],
      ],
      [
        "https://t.example/2.png",
        [
          [8, 9],
          [5, 7],
        ],
      ],
    ]);
  });

  test("never loads an image it may not, granted or not (ADR-0055 §2, §11)", () => {
    for (const src of [
      "http://t.example/p.png",
      "https://localhost/p.png",
      "https://10.0.0.1/p.png",
      "https://t.example",
      "img/p.png",
    ]) {
      const html = render(`![a](${src})`, () => true);
      expect(html, src).not.toContain("<img");
      expect(html, src).not.toContain("remote-image-case");
      expect(html, src).toContain('class="remote-image"');
    }
  });

  test("shows an embedded raster image, not an SVG one", () => {
    expect(render("![dot](data:image/png;base64,iVBO)")).toBe(
      '<p><img src="data:image/png;base64,iVBO" alt="dot"></p>\n',
    );
    expect(render("![s](data:image/svg+xml;base64,PHN2Zz4=)")).not.toContain(
      "<img",
    );
  });
});

describe("attached images (ADR-0057 §8)", () => {
  const ID = "AAECAwQFBgcICQoLDA0ODw";

  test("an image of this document is a slot the view fills, with its text", () => {
    expect(render(`![a & b](attachment:${ID})`)).toBe(
      `<p><span class="attached-image" data-attachment="${ID}"><span class="attached-image-text">a &amp; b</span></span></p>\n`,
    );
    // By reference, as any image.
    expect(render(`![x][r]\n\n[r]: attachment:${ID}`)).toContain(
      `data-attachment="${ID}"`,
    );
  });

  test("an identifier not of W-53 cites nothing: a slot without one", () => {
    for (const src of [
      "attachment:AAECAwQFBgcICQoLDA0ODB",
      "attachment:",
      "attachment:../x",
      `attachment:${ID}x`,
    ]) {
      expect(render(`![t](${src})`), src).toBe(
        '<p><span class="attached-image" data-attachment=""><span class="attached-image-text">t</span></span></p>\n',
      );
    }
  });

  test("never an <img> of its own, nor a link to load", () => {
    const html = render(`![t](attachment:${ID})`, () => true);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("href");
  });
});

describe("leavingHref", () => {
  test("a link that leaves the document, as the preview renders it", () => {
    expect(leavingHref("https://x.org/a b")).toBe("https://x.org/a%20b");
    expect(leavingHref("mailto:a@b.org")).toBe("mailto:a@b.org");
    expect(leavingHref("//host.org/x")).toBe("//host.org/x");
  });

  test("none for what the preview refuses or keeps in the document", () => {
    for (const href of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "vbscript:x",
      "data:text/html,x",
      "file:///etc/passwd",
      "#section",
      "page.md",
      "/path",
      "",
    ]) {
      expect(leavingHref(href)).toBeNull();
    }
  });
});

describe("callouts (phase 15)", () => {
  // Their icons apart (tested below), the HTML around them.
  const renderMarkdown = (source: string) =>
    render(source).replace(
      /<span class="md-callout-(?:icon|fold)"><svg[\s\S]*?<\/svg><\/span>/g,
      "",
    );
  const flat = (source: string) => renderMarkdown(source).replace(/\n/g, "");

  test("its title opens with its family's icon; a foldable one's ends with a chevron (decision 6)", () => {
    expect(render("> [!faq] T")).toContain(
      `<div class="md-callout-title"><span class="md-callout-icon">${calloutIcon("question")}</span>T</div>`,
    );
    expect(render("> [!warning]- T\n> x")).toContain(
      `<summary class="md-callout-title"><span class="md-callout-icon">${calloutIcon("warning")}</span>T<span class="md-callout-fold">${CALLOUT_FOLD_ICON}</span></summary>`,
    );
    // A default title, the same.
    expect(render("> [!Mon Type]+")).toContain(
      `<summary class="md-callout-title"><span class="md-callout-icon">${calloutIcon("note")}</span><span class="md-callout-default-title">Mon type</span><span class="md-callout-fold">`,
    );
    expect(calloutIcon("warning")).not.toBe(calloutIcon("tip"));
    expect(calloutIcon("warning")).toContain('aria-hidden="true"');
  });

  test("a quote opened by `[!type]`: its title, then its content", () => {
    expect(renderMarkdown("> [!warning] Titre *beau*\n> contenu")).toBe(
      '<div class="md-callout md-callout-warning" data-callout="warning">\n' +
        '<div class="md-callout-title">Titre <em>beau</em></div>\n' +
        '<div class="md-callout-content">\n<p>contenu</p>\n</div>\n</div>\n',
    );
  });

  test("the first paragraph's other lines, lazy ones too, then the other blocks", () => {
    expect(flat("> [!note] T\nlazy\n> more\n>\n> - item")).toBe(
      '<div class="md-callout md-callout-note" data-callout="note">' +
        '<div class="md-callout-title">T</div>' +
        '<div class="md-callout-content"><p>lazymore</p>' +
        "<ul><li>item</li></ul></div></div>",
    );
    expect(flat("> [!note] T\n>\n> para")).toBe(
      '<div class="md-callout md-callout-note" data-callout="note">' +
        '<div class="md-callout-title">T</div>' +
        '<div class="md-callout-content"><p>para</p></div></div>',
    );
  });

  test("a title alone; an empty title, the type's, as text", () => {
    expect(flat("> [!tip] Seul")).toBe(
      '<div class="md-callout md-callout-tip" data-callout="tip">' +
        '<div class="md-callout-title">Seul</div></div>',
    );
    expect(flat("> [!foo-bar]\n> x")).toContain(
      '<div class="md-callout-title"><span class="md-callout-default-title">Foo bar</span></div>',
    );
    expect(flat("> [!*a*]")).toContain(
      '<span class="md-callout-default-title">*a*</span>',
    );
  });

  test("the type in its attribute, normalized and escaped; an alias, its family's class", () => {
    expect(flat('> [!Mon "Type<]')).toContain(
      '<div class="md-callout md-callout-note" data-callout="mon-&quot;type&lt;">',
    );
    expect(flat("> [!CAUTION]")).toContain(
      '<div class="md-callout md-callout-warning" data-callout="caution">',
    );
  });

  test("nested: in a callout, in a quote, in a list item; a quote in a callout", () => {
    expect(flat("> [!note] A\n> > [!tip] B\n> > x")).toBe(
      '<div class="md-callout md-callout-note" data-callout="note">' +
        '<div class="md-callout-title">A</div><div class="md-callout-content">' +
        '<div class="md-callout md-callout-tip" data-callout="tip">' +
        '<div class="md-callout-title">B</div><div class="md-callout-content">' +
        "<p>x</p></div></div></div></div>",
    );
    expect(flat("> > [!tip] B")).toBe(
      '<blockquote><div class="md-callout md-callout-tip" data-callout="tip">' +
        '<div class="md-callout-title">B</div></div></blockquote>',
    );
    expect(flat("- item\n  > [!note] L\n  > c")).toContain(
      '<li>item<div class="md-callout md-callout-note" data-callout="note">',
    );
    expect(flat("> [!note] A\n> > q")).toContain(
      '<div class="md-callout-content"><blockquote><p>q</p></blockquote></div>',
    );
  });

  test("not a callout: two spaces after `>`, second line, heading, escaped, code, outside a quote", () => {
    for (const source of [
      ">  [!note] deux espaces",
      "> premier\n> [!note] second",
      // Not on the quote's first line, as in Obsidian (essai 15e.2).
      ">\n> [!note] après une ligne vide",
      "> >\n> > [!tip] dans une citation",
      "> # x\n> [!note]",
      "> ## [!note]",
      "> \\[!note]",
      "> `[!note]`",
      "> **[!note]**",
      ">     [!note] code",
      "> [!tip]-Collé",
      "[!note] dehors",
      "- [!note] item",
    ]) {
      expect(renderMarkdown(source), source).not.toContain("md-callout");
    }
  });

  test("a fold sign: a <details>, folded for `-`, unfolded for `+`, its title the summary", () => {
    expect(renderMarkdown("> [!warning]- Titre *beau*\n> contenu")).toBe(
      '<details class="md-callout md-callout-warning" data-callout="warning">\n' +
        '<summary class="md-callout-title">Titre <em>beau</em></summary>\n' +
        '<div class="md-callout-content">\n<p>contenu</p>\n</div>\n</details>\n',
    );
    expect(flat("> [!tip]+\n> x")).toBe(
      '<details class="md-callout md-callout-tip" data-callout="tip" open>' +
        '<summary class="md-callout-title"><span class="md-callout-default-title">Tip</span></summary>' +
        '<div class="md-callout-content"><p>x</p></div></details>',
    );
    expect(flat("> [!note]- A\n> > [!tip] B\n> > x")).toBe(
      '<details class="md-callout md-callout-note" data-callout="note">' +
        '<summary class="md-callout-title">A</summary><div class="md-callout-content">' +
        '<div class="md-callout md-callout-tip" data-callout="tip">' +
        '<div class="md-callout-title">B</div><div class="md-callout-content">' +
        "<p>x</p></div></div></div></details>",
    );
  });

  test("a formula block in a callout: its TeX without the quote's markers", () => {
    const html = renderMarkdown("> [!note] F\n>\n> $$\n> x\n> $$");
    expect(/data-tex="([^"]*)"/.exec(html)?.[1]?.trim()).toBe("x");
  });
});

describe("Obsidian's [[…]] (phase 19, decision 7)", () => {
  test("a heading of this document: a link to its anchor, its alias or its path shown", () => {
    expect(render("[[#Mon titre]]")).toBe(
      '<p><a class="md-wikilink" href="#Mon%20titre">Mon titre</a></p>\n',
    );
    expect(render("[[#Mon titre|ici]]")).toBe(
      '<p><a class="md-wikilink" href="#Mon%20titre">ici</a></p>\n',
    );
    expect(render("[[#Parent#Enfant]]")).toBe(
      '<p><a class="md-wikilink" href="#Parent%23Enfant">Parent#Enfant</a></p>\n',
    );
  });

  test("a note of someone's vault, or a block: shown, not a link", () => {
    expect(render("[[Note]] et [[Note#T|<b>]] et [[#^bloc]]")).toBe(
      '<p><span class="md-wikilink md-wikilink-local" data-wikilink="note">Note</span> et ' +
        '<span class="md-wikilink md-wikilink-local" data-wikilink="note">&lt;b&gt;</span> et ' +
        '<span class="md-wikilink md-wikilink-local" data-wikilink="block">^bloc</span></p>\n',
    );
  });

  test("before links and footnotes: even with a reference of that name", () => {
    expect(render("[[x]]\n\n[x]: https://e.org")).toBe(
      '<p><span class="md-wikilink md-wikilink-local" data-wikilink="note">x</span></p>\n',
    );
    expect(render("[[^1]]\n\n[^1]: n")).toContain(
      'data-wikilink="note">^1</span>',
    );
  });

  test("text: an embed, an empty one, one across lines, in code", () => {
    expect(render("![[Note]]")).toBe("<p>![[Note]]</p>\n");
    expect(render("[[]] [[ ]]")).toBe("<p>[[]] [[ ]]</p>\n");
    expect(render("[[a\nb]]")).toBe("<p>[[a\nb]]</p>\n");
    expect(render("`[[a]]`")).toBe("<p><code>[[a]]</code></p>\n");
    expect(render("\\[[a]]")).toBe("<p>[[a]]</p>\n");
  });
});

describe("remoteImageSources (ADR-0055 §4)", () => {
  test("the remote images the page may load, each once, in the text's order", () => {
    expect(
      remoteImageSources(
        "![a](https://b.example/1.png) ![c][r] ![d](https://a.example/2.png)\n\n" +
          "> ![e](https://b.example/1.png)\n\n[r]: https://c.example/3.png\n",
      ),
    ).toEqual([
      "https://b.example/1.png",
      "https://c.example/3.png",
      "https://a.example/2.png",
    ]);
  });

  test("not an image the page never loads, nor one in code", () => {
    expect(
      remoteImageSources(
        "![a](http://b.example/1.png) ![b](https://localhost/x.png) " +
          "![c](data:image/png;base64,iVBO) [link](https://d.example/x.png)\n\n" +
          "`![d](https://e.example/x.png)`\n\n```\n![f](https://f.example/x.png)\n```\n",
      ),
    ).toEqual([]);
  });

  test("nothing parsed when the text can have no such image", () => {
    resetCounters();
    expect(remoteImageSources("plain [a](https://x.example/) text")).toEqual(
      [],
    );
    expect(remoteImageSources("![a](b.png) and ![c](d.png)")).toEqual([]);
    expect(counter("images.scan")).toBe(0);
    remoteImageSources("![a](HTTPS://x.example/a.png)");
    expect(counter("images.scan")).toBe(1);
  });
});
