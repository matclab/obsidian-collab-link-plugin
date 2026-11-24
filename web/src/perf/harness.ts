import { encrypt, generateKey } from "../../lib/src/crypto/aead.js";
import { EDITOR } from "../../lib/src/transport/test-support/credentials.js";
import { FakeServer } from "../../lib/src/transport/test-support/fake-server.js";
import { type OpenedDocument, openDocument } from "../app/open-document.js";
import type { EditorFactory } from "../editor/editor.js";
import type { ScenarioEntry } from "./scenario.js";

export const settle = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

export interface SeededDocument {
  server: FakeServer;
  documentId: string;
  key: CryptoKey;
}

/** A fake server holding `journal`, encrypted, as one document. */
export async function seedDocument(
  journal: ScenarioEntry[],
): Promise<SeededDocument> {
  const server = new FakeServer();
  const documentId = "bench";
  const key = await generateKey();
  for (const entry of journal) {
    server.append(
      documentId,
      entry.channel,
      await encrypt(key, entry.plaintext),
    );
  }
  return { server, documentId, key };
}

/** Opens the seeded document as a new page would (`openDocument`, in the
 * current DOM — jsdom in tests), until the page has settled: history
 * imported, effects applied, rendered. */
/** Closes a page opened by `openSeeded`: its connection, and its
 * presence, whose timers would otherwise keep publishing (and counting). */
export function closePage(opened: OpenedDocument): void {
  opened.presence.destroy();
  opened.connection.close();
}

export async function openSeeded(
  seeded: SeededDocument,
  author = "reader",
  /** The text formatted, as the page shows it by default. */
  livePreview = false,
  /** A host's editor, in place of the page's. */
  editor?: EditorFactory,
): Promise<OpenedDocument> {
  const opened = await openDocument({
    livePreview,
    ...(editor && { editor }),
    url: "fake://bench",
    documentId: seeded.documentId,
    key: seeded.key,
    credentials: EDITOR,
    editorParent: document.createElement("div"),
    panelParent: document.createElement("div"),
    author: () => author,
    socketFactory: () => seeded.server.connect(),
  });
  await settle();
  await settle();
  return opened;
}
