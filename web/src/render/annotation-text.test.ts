import { describe, expect, test } from "vitest";
import { renderAnnotationText as render } from "./annotation-text.js";

const OUT = 'target="_blank" rel="noopener noreferrer"';

// ADR-0047 §2: what an annotation's text renders.
describe("renderAnnotationText: rendered", () => {
  test("emphasis, strong, strikethrough, inline code", () => {
    expect(render("a *b* **c** ~~d~~ `e`")).toBe(
      "<p>a <em>b</em> <strong>c</strong> <s>d</s> <code>e</code></p>\n",
    );
  });

  test("a highlight, in the color its emoji names (ADR-0044)", () => {
    expect(render("==a== ==🔴b==")).toBe(
      '<p><mark>a</mark> <mark class="md-highlight-red">b</mark></p>\n',
    );
  });

  test("paragraphs, and a line break as a line break (decision 3)", () => {
    expect(render("a\nb\n\nc")).toBe("<p>a<br>\nb</p>\n<p>c</p>\n");
  });

  test("lists, bulleted and numbered", () => {
    expect(render("- a\n- b\n\n3. c")).toBe(
      '<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n<ol start="3">\n<li>c</li>\n</ol>\n',
    );
  });

  test("a quote", () => {
    expect(render("> a")).toBe("<blockquote>\n<p>a</p>\n</blockquote>\n");
  });

  test("code blocks, fenced or indented; a mermaid one stays code", () => {
    expect(render("```js\nx < 1\n```")).toBe(
      '<pre><code class="language-js">x &lt; 1\n</code></pre>\n',
    );
    expect(render("    code")).toBe("<pre><code>code\n</code></pre>\n");
    expect(render("```mermaid\ngraph TD\n```")).toBe(
      '<pre><code class="language-mermaid">graph TD\n</code></pre>\n',
    );
  });

  test("raw HTML stays text", () => {
    expect(render("<b>x</b> <script>")).toBe(
      "<p>&lt;b&gt;x&lt;/b&gt; &lt;script&gt;</p>\n",
    );
  });
});

describe("renderAnnotationText: left as written", () => {
  test("a heading, by # or underlined, and a rule", () => {
    expect(render("# T")).toBe("<p># T</p>\n");
    expect(render("text\n---")).toBe("<p>text<br>\n---</p>\n");
    expect(render("text\n===")).toBe("<p>text<br>\n===</p>\n");
    expect(render("___")).toBe("<p>___</p>\n");
  });

  test("a table", () => {
    expect(render("| a |\n|---|\n| b |")).toBe(
      "<p>| a |<br>\n|---|<br>\n| b |</p>\n",
    );
  });

  test("a checkbox", () => {
    expect(render("- [ ] a\n- [x] b")).toBe(
      "<ul>\n<li>[ ] a</li>\n<li>[x] b</li>\n</ul>\n",
    );
  });

  // Without footnotes, CommonMark reads `[^1]: x` as a link reference
  // definition and drops the line: nothing a reviewer wrote may vanish.
  test("a footnote and its definition, as text (21.0)", () => {
    expect(render("a[^1]\n\n[^1]: word")).toBe(
      "<p>a[^1]</p>\n<p>[^1]: word</p>\n",
    );
    expect(render("[^n]: https://e.org\nnext")).toBe(
      "<p>[^n]: https://e.org<br>\nnext</p>\n",
    );
    expect(render("> [^1]: x")).toBe(
      "<blockquote>\n<p>[^1]: x</p>\n</blockquote>\n",
    );
  });

  test("a YAML header", () => {
    expect(render("---\na: b\n---")).toBe("<p>---<br>\na: b<br>\n---</p>\n");
  });

  test("a callout is a quote, its type as text", () => {
    expect(render("> [!note] T")).toBe(
      "<blockquote>\n<p>[!note] T</p>\n</blockquote>\n",
    );
  });

  test("formulas", () => {
    expect(render("$x$ and\n$$\ny\n$$")).toBe(
      "<p>$x$ and<br>\n$$<br>\ny<br>\n$$</p>\n",
    );
  });

  test("a wikilink", () => {
    expect(render("[[Note#Part|alias]]")).toBe("<p>[[Note#Part|alias]]</p>\n");
  });
});

// ADR-0047 §4: a link is a link only when it leaves the document.
describe("renderAnnotationText: links", () => {
  test("a link that leaves the document opens in a new tab, without its title", () => {
    expect(render('[a](https://e.org/x "t")')).toBe(
      `<p><a href="https://e.org/x" ${OUT}>a</a></p>\n`,
    );
    expect(render('[a](<https://e.org/x y> "t")')).toBe(
      `<p><a href="https://e.org/x%20y" ${OUT}>a</a></p>\n`,
    );
    expect(render("[m](mailto:a@e.org) [h](//e.org/x)")).toBe(
      `<p><a href="mailto:a@e.org" ${OUT}>m</a> <a href="//e.org/x" ${OUT}>h</a></p>\n`,
    );
  });

  test("an autolink, and a reference link", () => {
    expect(render("<https://e.org> <a@e.org>")).toBe(
      `<p><a href="https://e.org" ${OUT}>https://e.org</a> <a href="mailto:a@e.org" ${OUT}>a@e.org</a></p>\n`,
    );
    expect(render("[r] and [x][r]\n\n[r]: https://e.org")).toBe(
      `<p><a href="https://e.org" ${OUT}>r</a> and <a href="https://e.org" ${OUT}>x</a></p>\n`,
    );
  });

  test("a link inside the document, or relative, is its text, formatting kept", () => {
    expect(render("[**see**](#title) [b](other.md) [c](/path)")).toBe(
      "<p><strong>see</strong> b c</p>\n",
    );
    expect(render("[r]\n\n[r]: #a")).toBe("<p>r</p>\n");
    expect(render("<#a>")).toBe("<p>&lt;#a&gt;</p>\n");
  });

  test("a script link, whatever its spelling, is never a link", () => {
    for (const href of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "&#106;avascript:alert(1)",
      "javascript&colon;alert(1)",
      "vbscript:x",
      "data:text/html,x",
    ]) {
      expect(render(`[a](${href})`)).not.toContain("<a");
      expect(render(`<${href}>`)).not.toContain("<a");
    }
  });
});

// ADR-0047 §5: no image is ever shown.
describe("renderAnnotationText: images", () => {
  test("an image that leaves the document is a link to it, by its text or its address", () => {
    expect(render("![alt](https://e.org/i.png)")).toBe(
      `<p><a class="remote-image" href="https://e.org/i.png" ${OUT}>alt</a></p>\n`,
    );
    expect(render("![](https://e.org/i.png)")).toBe(
      `<p><a class="remote-image" href="https://e.org/i.png" ${OUT}>https://e.org/i.png</a></p>\n`,
    );
  });

  test("any other image is its text", () => {
    expect(render("![a *b*](x.png)")).toBe("<p>a b</p>\n");
    expect(render("![a](#x)")).toBe("<p>a</p>\n");
    expect(render("![a](data:image/png;base64,iVBO)")).not.toContain("<img");
  });
});

test("no id anywhere", () => {
  expect(render("# a\n\n[^1]\n\n[^1]: b\n\n[[#a]]")).not.toContain("id=");
});
