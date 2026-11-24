// Where a text's links are (docs/phase-19-liens.md, decisions 1 and 3): its
// `[[…]]`, and its links to a document of a server without the key — by
// the editor's parser, so that nothing in code is taken, for the Obsidian
// plugin to translate them at the edges of sharing.
import { describe, expect, test } from "vitest";
import { documentLinksIn, wikilinksIn } from "./link-ranges.js";

const ORIGIN = "https://collab.test";

describe("wikilinksIn", () => {
  test("each [[…]] with where it is, its target and its alias; none in code", () => {
    const text =
      "Vers [[B]], [[B#T|ici]] et `[[C]]`\n\n```\n[[D]]\n```\n\n> [[#Haut]]";
    expect(wikilinksIn(text)).toEqual([
      { from: 5, to: 10, target: "B", alias: null, kind: "note" },
      { from: 12, to: 23, target: "B#T", alias: "ici", kind: "note" },
      {
        from: text.indexOf("[[#Haut]]"),
        to: text.length,
        target: "#Haut",
        alias: null,
        kind: "heading",
      },
    ]);
  });
});

describe("documentLinksIn", () => {
  test("each link to a document of that server: inline or automatic, its text, its id, its heading", () => {
    const text = `Voir [le *plan*](${ORIGIN}/?doc=b#h=Partie%20un), <${ORIGIN}/?doc=c> et [x](https://ailleurs.test/?doc=d), [y](${ORIGIN}/?doc=e#k=K&r=edit.S), \`[z](${ORIGIN}/?doc=f)\`.`;
    expect(documentLinksIn(text, ORIGIN)).toEqual([
      {
        from: 5,
        to: text.indexOf(")") + 1,
        text: "le *plan*",
        documentId: "b",
        heading: "Partie un",
      },
      {
        from: text.indexOf("<"),
        to: text.indexOf(">") + 1,
        text: null,
        documentId: "c",
        heading: null,
      },
    ]);
  });

  test("an escaped bracket in its text: read as written there", () => {
    const text = `[a \\[v2\\]](${ORIGIN}/?doc=b)`;
    expect(documentLinksIn(text, ORIGIN)[0]?.text).toBe("a [v2]");
  });
});
