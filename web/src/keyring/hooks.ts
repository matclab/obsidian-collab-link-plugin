/** What a document view tells the keyring (docs/protocol/05-keyring.md,
 * KR-23, KR-24; decision 7; TR2), on the tab's session — if there is one:
 * without a keyring, nothing is written and nothing waits. */
import {
  CloseCode,
  excludeDocument,
  noteCreated,
  noteDeleted,
  noteOpened,
  noteRefused,
  rememberLink,
} from "../../lib/src/index.js";
import type { KeyringSession } from "./session.js";

/** The hooks a document view calls (`DocumentTarget.keyring`). */
export interface DocumentKeyring {
  /** The server accepted this link's secret (KR-23). */
  opened(link: string): Promise<void>;
  /** The document's title, kept once per opening (decision 7). */
  title(title: string): Promise<void>;
  /** The server closed with `code`, this link's secret in hand. */
  refused(link: string, code: number): Promise<void>;
  /** A rotation's new edit link: resolves once it is in the stored copy,
   * rejects if it can't be (TR2): the rotation then isn't sent. */
  keep(editLink: string): Promise<void>;
  /** Whether this device has a keyring: without one, nothing to keep. */
  available(): Promise<boolean>;
  /** « Garder ce document dans Mes documents » (KR-24). */
  isKept(): Promise<boolean>;
  setKept(kept: boolean, link: string): Promise<void>;
  /** The tab's list replaced (LA2): what was noted —
   * perhaps in no list at all — noted again in the new one. */
  again(): Promise<void>;
  /** A link of another document the person gave, pasted into the text
   * (KR-23): kept, unless taken out (KR-24). */
  given(link: string): Promise<void>;
  /** The title the list holds of a document, as last read: none before
   * the list is read. Without waiting: a paste can't. */
  titleOf(documentId: string): string | undefined;
}

export function documentKeyring(
  /** The tab's session as it is now: an association with the identity
   * replaces it. */
  sessionNow: () => Promise<KeyringSession | undefined>,
  documentId: string,
  options: { created?: boolean; now: () => number },
): DocumentKeyring {
  let titled = false;
  /** What this view noted: its latest link, accepted (KR-23), its title. */
  let latest: string | undefined;
  let titleKept: string | undefined;
  /** The session last read, for `titleOf`. */
  let seen: KeyringSession | undefined;
  const read = async () => {
    seen = await sessionNow();
    return seen;
  };
  void read().catch(() => {});
  const change = async (edit: Parameters<KeyringSession["change"]>[0]) => {
    const s = await read();
    return s ? s.change(edit) : "saved";
  };
  return {
    async opened(link) {
      latest = link;
      await change((doc) => {
        if (!rememberLink(doc, link, { at: options.now() })) return;
        noteOpened(doc, documentId, options.now());
        if (options.created) noteCreated(doc, documentId);
      });
    },
    async title(title) {
      if (titled) return;
      titled = true;
      titleKept = title;
      await change((doc) => {
        if (doc.getMap("excluded").get(documentId) !== undefined) return;
        noteOpened(doc, documentId, options.now(), title);
      });
    },
    async refused(link, code) {
      await change((doc) => {
        if (code === CloseCode.Deleted)
          noteDeleted(doc, documentId, options.now());
        else if (
          code === CloseCode.Unauthenticated ||
          code === CloseCode.Revoked
        )
          noteRefused(doc, link);
      });
    },
    async keep(editLink) {
      latest = editLink;
      const kept = await change(
        (doc) => void rememberLink(doc, editLink, { at: options.now() }),
      );
      if (kept === "superseded") {
        throw new Error(
          "another keyring is on this device now: reload the page",
        );
      }
    },
    async available() {
      return (await sessionNow()) !== undefined;
    },
    async isKept() {
      const s = await sessionNow();
      return !!s?.entries().some((entry) => entry.documentId === documentId);
    },
    async setKept(kept, link) {
      await change((doc) => {
        if (kept)
          rememberLink(doc, link, { explicit: true, at: options.now() });
        else excludeDocument(doc, documentId, options.now());
      });
    },
    async given(link) {
      await change(
        (doc) => void rememberLink(doc, link, { at: options.now() }),
      );
    },
    titleOf(id) {
      return (
        seen?.entries().find((entry) => entry.documentId === id)?.title ??
        undefined
      );
    },
    async again() {
      const link = latest;
      if (link === undefined) return;
      await change((doc) => {
        // Taken out of the list, it stays out (KR-24).
        if (!rememberLink(doc, link, { at: options.now() })) return;
        noteOpened(doc, documentId, options.now(), titleKept);
        if (options.created) noteCreated(doc, documentId);
      });
    },
  };
}
