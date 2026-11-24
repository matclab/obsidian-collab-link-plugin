// "Share this note" (docs/phase-14-plugin-obsidian.md, decisions 9, 11;
// analysis 14d): the note's text, its YAML header included, goes into a
// new document — its CriticMarkup as annotations (ADR-0034) —; the link
// is kept, then the file becomes the export, only once the server has
// acknowledged the text and only if the file is still that text (SI1).
import { describe, expect, test } from "vitest";
import {
  createDocument,
  listAnnotations,
  openLink,
} from "../../web/lib/src/index.js";
import { FakeServer } from "../../web/lib/src/transport/test-support/fake-server.js";
import { parseVersion, readHeader } from "./note-header.js";
import { shareNote } from "./share.js";

const SERVER = "https://collab.test";
const NOTE = "---\ntags: [minutes]\n---\n# Minutes\n\nWe {++really ++}agree.\n";

function setUp(file = NOTE) {
  const server = new FakeServer();
  const log: string[] = [];
  const note = { text: file };
  const options = {
    text: NOTE,
    server: SERVER,
    author: "alice",
    create: () =>
      createDocument(SERVER, async () => Response.json({ document_id: "doc" })),
    connect: (url: string) =>
      openLink(url, { socketFactory: () => server.connect() }),
    keep: (documentId: string, url: string) => {
      log.push(`keep ${documentId} ${url.includes("#") ? "link" : "?"}`);
    },
    rewrite: async (fn: (current: string) => string) => {
      log.push("rewrite");
      note.text = fn(note.text);
      return note.text;
    },
  };
  return { server, log, note, options };
}

describe("sharing a note", () => {
  test("its text, header included, is the new document's; its CriticMarkup, annotations; the file, the export", async () => {
    const { server, log, note, options } = setUp();

    const shared = await shareNote(options);

    if (!shared.ok) throw new Error("not shared");
    expect(log).toEqual(["keep doc link", "rewrite"]);
    const reader = await openLink(shared.editLink, {
      socketFactory: () => server.connect(),
    });
    const text = reader.content.getText("content").toString();
    // A proposed insertion is not in the text until accepted (ADR-0034).
    expect(text).toBe("---\ntags: [minutes]\n---\n# Minutes\n\nWe agree.\n");
    expect(
      listAnnotations(reader.content, reader.annotations).map((a) => a.type),
    ).toEqual(["addition"]);
    // The file: that text, with the two properties first (decision 3).
    const { content, header } = readHeader(note.text);
    expect(content).toBe(text);
    expect(header?.document).toBe("doc");
    const version = parseVersion(header?.version ?? "x");
    expect(version).toBeDefined();
    expect(
      reader.content
        .forkAt(version ?? [])
        .getText("content")
        .toString(),
    ).toBe(text);
    reader.close();
  });

  test("its links as the vault says, in the document; the file compared as it was (phase 19, decision 1)", async () => {
    const { server, note, options } = setUp();
    const shared = await shareNote({
      ...options,
      links: (text) => text.replace("Minutes", "Compte rendu"),
    });
    if (!shared.ok) throw new Error("not shared");
    const reader = await openLink(shared.editLink, {
      socketFactory: () => server.connect(),
    });
    expect(reader.content.getText("content").toString()).toContain(
      "# Compte rendu",
    );
    expect(readHeader(note.text).content).toContain("# Compte rendu");
  });

  test("a note changed while it was shared is left as it is (SI1)", async () => {
    const { note, options } = setUp("# Minutes\n\nTyped meanwhile.\n");

    const shared = await shareNote(options);

    expect(shared).toEqual({ ok: false, reason: "changed" });
    expect(note.text).toBe("# Minutes\n\nTyped meanwhile.\n");
  });

  test("a document that can't be created leaves the note as it is, and keeps no link", async () => {
    const { log, note, options } = setUp();

    await expect(
      shareNote({
        ...options,
        create: () => Promise.reject(new Error("offline")),
      }),
    ).rejects.toThrow("offline");

    expect(log).toEqual([]);
    expect(note.text).toBe(NOTE);
  });
});
