// @vitest-environment jsdom
// The writing help (phase 20d, ADR-0046 §6): what one types and what one
// gets, rendered by the preview itself (WA7); the shortcuts as the
// platform writes them; what is good to know.
import { afterEach, describe, expect, test } from "vitest";
import { markdownParser } from "../../editor/markdown-syntax.js";
import { setLanguage } from "../../i18n/index.js";
import { renderMarkdown } from "../../render/index.js";
import { HELP_ENTRIES, createWritingHelp } from "./writing-help.js";

afterEach(() => {
  document.body.textContent = "";
  setLanguage("en");
});

function nodesIn(source: string): Set<string> {
  const names = new Set<string>();
  markdownParser()
    .parse(source)
    .iterate({ enter: (node) => void names.add(node.name) });
  return names;
}

describe("the writing help's examples (WA7)", () => {
  for (const language of ["en", "fr"] as const) {
    test(`each rendered by the preview, found by the editor's parser, in ${language}`, () => {
      setLanguage(language);
      for (const entry of HELP_ENTRIES) {
        const source = entry.example();
        const root = document.createElement("div");
        root.innerHTML = renderMarkdown(source);
        expect(
          root.querySelector(entry.drawn),
          `${entry.id}: ${source}`,
        ).not.toBeNull();
        expect(nodesIn(source).has(entry.node), `${entry.id}: ${source}`).toBe(
          true,
        );
      }
    });
  }
});

describe("the writing help", () => {
  test("good to know: the / menu, and the headings offered in a link (phase 20, decision 9)", () => {
    for (const [language, expected] of [
      ["en", "Type ](# or [[# in a link to choose a heading of the document."],
      [
        "fr",
        "Tapez ](# ou [[# dans un lien pour choisir un titre du document.",
      ],
    ] as const) {
      setLanguage(language);
      const help = createWritingHelp(document.body, { mac: false });
      help.open();
      const notes = Array.from(document.querySelectorAll(".help-notes li")).map(
        (li) => li.textContent,
      );
      expect(notes).toContain(expected);
      document.body.textContent = "";
    }
  });

  test("a dialog of three parts; each example with what it gives", () => {
    const help = createWritingHelp(document.body, { mac: false });
    help.open();
    const dialog =
      document.querySelector<HTMLDialogElement>("dialog.help-dialog");
    expect(dialog?.open).toBe(true);
    expect(
      Array.from(dialog?.querySelectorAll("h3.help-part") ?? []).map(
        (h) => h.textContent,
      ),
    ).toEqual(["Writing in Markdown", "Shortcuts", "Good to know"]);
    // What an annotation's text shows of Markdown (ADR-0047).
    expect(
      Array.from(
        dialog?.querySelectorAll(".help-notes li") ?? [],
        (item) => item.textContent,
      ),
    ).toContain(
      "Comments and replies show emphasis, lists, quotes, code and links that leave the document; not headings, tables, images, formulas, nor links inside it.",
    );
    // What awaits a reply, and how to go there (ADR-0050 §5).
    expect(
      Array.from(
        dialog?.querySelectorAll(".help-notes li") ?? [],
        (item) => item.textContent,
      ),
    ).toContain(
      "« To answer » counts the open annotations whose last entry is someone else's; ‹ › or F8 / Shift+F8 go from one to the next in the text, « Nothing to add » sets one aside until its next reply.",
    );
    // Suggesting at the caret, and where at a line's start (phase 24).
    expect(
      Array.from(
        dialog?.querySelectorAll(".help-notes li") ?? [],
        (item) => item.textContent,
      ),
    ).toContain(
      "Without selecting anything, « Suggest » proposes a text at the caret (in Review, for those who can also write). At the start of a heading, an item or a quote, it asks where to add it: as a new paragraph before the line, or at the start of its text.",
    );
    const bold = dialog?.querySelector('[data-construct="bold"]');
    expect(bold?.querySelector("code")?.textContent).toBe("**a word**");
    expect(bold?.querySelector("strong")?.textContent).toBe("a word");
    // A task's box named for a screen reader, as in the preview (axe,
    // check:ui).
    const box = dialog?.querySelector(
      '[data-construct="taskList"] input[type="checkbox"]',
    );
    expect(box?.getAttribute("aria-label")).toBe("Task");
    // A formula and a diagram are drawn by the preview's loaders: their
    // source only, and where they are drawn.
    const formula = dialog?.querySelector('[data-construct="mathBlock"]');
    expect(formula?.querySelector(".help-drawn")?.textContent).toBe(
      "Drawn in Reading",
    );
  });

  test("the shortcuts as the platform writes them", () => {
    createWritingHelp(document.body, { mac: true }).open();
    const keys = Array.from(
      document.querySelectorAll(".help-shortcuts kbd"),
    ).map((kbd) => kbd.textContent);
    expect(keys).toContain("⌘B");
    expect(keys).toContain("/");
    expect(keys).toContain("⌘+click");
  });

  test("Ctrl/Cmd+click: a link, and a footnote's way there and back (phase 20, decision 8)", () => {
    setLanguage("fr");
    createWritingHelp(document.body, { mac: false }).open();
    const rows = Array.from(
      document.querySelectorAll(".help-shortcuts dt"),
      (dt) => `${dt.textContent} ${dt.nextElementSibling?.textContent}`,
    );
    expect(rows).toContain(
      "Ctrl+clic Ouvrir un lien ; aller d'une note à son texte, et retour",
    );
  });

  test("moving a section, moving, copying and deleting lines, redoing", () => {
    setLanguage("fr");
    createWritingHelp(document.body, { mac: false }).open();
    const rows = Array.from(
      document.querySelectorAll(".help-shortcuts dt"),
      (dt) => `${dt.textContent} ${dt.nextElementSibling?.textContent}`,
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        "Ctrl+Maj+↑ ↓ Déplacer la section (son titre et son texte) avant la précédente ou après la suivante",
        "Alt+↑ ↓ Monter ou descendre les lignes",
        "Alt+Maj+↑ ↓ Copier les lignes au-dessus ou au-dessous",
        "Ctrl+Maj+K Supprimer la ligne",
        "Ctrl+Y Rétablir",
      ]),
    );
  });

  test("Tab and Shift+Tab, and how to leave the text by keyboard (ADR-0054)", () => {
    setLanguage("fr");
    createWritingHelp(document.body, { mac: false }).open();
    const rows = Array.from(
      document.querySelectorAll(".help-shortcuts dt"),
      (dt) => `${dt.textContent} ${dt.nextElementSibling?.textContent}`,
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        "Tab Mettre en retrait, ou décaler un élément de liste",
        "Maj+Tab Retirer un retrait, ou remonter un élément de liste",
        "Échap, Tab Quitter le texte au clavier, vers le champ suivant",
        "Ctrl+M Tab : retrait, ou passage au champ suivant",
      ]),
    );
  });

  test("Ctrl+Enter sends an annotation's text, a reply", () => {
    setLanguage("fr");
    createWritingHelp(document.body, { mac: false }).open();
    const rows = Array.from(
      document.querySelectorAll(".help-shortcuts dt"),
      (dt) => `${dt.textContent} ${dt.nextElementSibling?.textContent}`,
    );
    expect(rows).toContain(
      "Ctrl+Entrée Envoyer un commentaire, une suggestion ou une réponse",
    );
    document.body.replaceChildren();
    createWritingHelp(document.body, { mac: true }).open();
    expect(
      Array.from(
        document.querySelectorAll(".help-shortcuts kbd"),
        (kbd) => kbd.textContent,
      ),
    ).toContain("⌘↩");
  });

  test("the same keys on a Mac", () => {
    createWritingHelp(document.body, { mac: true }).open();
    const keys = Array.from(
      document.querySelectorAll(".help-shortcuts kbd"),
    ).map((kbd) => kbd.textContent);
    expect(keys).toEqual(
      expect.arrayContaining([
        "⇧⌘↑ ↓",
        "⌥↑ ↓",
        "⇧⌥↑ ↓",
        "⇧⌘K",
        "⇧⌘Z",
        "⇧Tab",
        "⇧⌥M",
      ]),
    );
  });

  test("the keys named as the keyboard of the language writes them", () => {
    setLanguage("fr");
    createWritingHelp(document.body, { mac: false }).open();
    const keys = Array.from(
      document.querySelectorAll(".help-shortcuts kbd"),
    ).map((kbd) => kbd.textContent);
    expect(keys).toContain("Ctrl+Maj+X");
  });
});
