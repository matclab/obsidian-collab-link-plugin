// @vitest-environment jsdom
//
// Presence wired as the page runs it (ADR-0025): an editor's selection
// reaches the other pages, a reader's never leaves it; a rename is sent.
import { EditorSelection } from "@codemirror/state";
import { describe, expect, test, vi } from "vitest";
import { generateKey } from "../../lib/src/crypto/aead.js";
import {
  EDITOR,
  READER,
} from "../../lib/src/transport/test-support/credentials.js";
import { eventually } from "../../lib/src/transport/test-support/eventually.js";
import { FakeServer } from "../../lib/src/transport/test-support/fake-server.js";
import { openDocument } from "./open-document.js";

async function open(
  server: FakeServer,
  key: CryptoKey,
  credentials: typeof EDITOR | typeof READER,
  author: () => string,
) {
  return openDocument({
    url: "wss://fake/ws",
    documentId: "doc",
    key,
    credentials,
    editorParent: document.createElement("div"),
    panelParent: document.createElement("div"),
    author,
    socketFactory: () => server.connect(),
  });
}

describe("openDocument, presence", () => {
  test("an editor's selection reaches a reader; the reader sends none", async () => {
    const key = await generateKey();
    const server = new FakeServer();
    let name = "alice";
    const editor = await open(server, key, EDITOR, () => name);
    editor.contentDoc.getText("content").insert(0, "hello world");
    editor.contentDoc.commit();
    const reader = await open(server, key, READER, () => "reader");
    await eventually(
      () => reader.contentDoc.getText("content").toString() === "hello world",
    );

    editor.client.editor.view.dispatch({
      selection: EditorSelection.single(6, 11),
      userEvent: "select",
    });

    await eventually(() =>
      reader.presence
        .others()
        .some(
          (other) =>
            other.name === "alice" && other.anchor === 6 && other.head === 11,
        ),
    );
    reader.client.editor.view.dispatch({
      selection: EditorSelection.single(1, 2),
      userEvent: "select",
    });
    name = "Alice B.";
    editor.presence.renamed();
    await eventually(() =>
      reader.presence.others().some((other) => other.name === "Alice B."),
    );
    expect(editor.presence.others()).toEqual([]);
    for (const page of [editor, reader]) {
      page.presence.destroy();
      page.connection.close();
    }
  });

  test("another's text moves no selection of mine: none is sent", async () => {
    const key = await generateKey();
    const server = new FakeServer();
    const mine = await open(server, key, EDITOR, () => "alice");
    const theirs = await open(server, key, EDITOR, () => "bob");
    const sent = vi.spyOn(mine.presence, "setSelection");

    theirs.client.editor.view.dispatch({
      changes: { from: 0, insert: "theirs" },
      userEvent: "input.type",
    });
    await eventually(
      () => mine.contentDoc.getText("content").toString() === "theirs",
    );

    expect(sent).not.toHaveBeenCalled();
    for (const page of [mine, theirs]) {
      page.presence.destroy();
      page.connection.close();
    }
  });
});
