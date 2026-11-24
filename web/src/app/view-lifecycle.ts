import {
  CloseCode,
  type DocumentConnection,
  type LinkFragment,
  type Role,
  type documentLinks,
  forgetPendingSecret,
  formatLinkFragment,
  pendingSecret,
  renewLinks,
  roleSecretHeader,
} from "../../lib/src/index.js";
import { t } from "../i18n/index.js";
import type { DocumentKeyring } from "../keyring/hooks.js";
import {
  type DocumentLifecycle,
  createDocumentLifecycle,
} from "../ui/menu/document-lifecycle.js";
import type { SharePanel } from "../ui/menu/share-panel.js";
import { refusalMessage } from "./messages.js";

/** The life of a document view's link: the edit secret and
 * its rotations (ADR-0019 §5, R-B4), the share panel's links, a refusal,
 * the expiry and the deletion (ADR-0023, ADR-0024). Started before the
 * document opens, told of it as its parts exist. Its interleavings:
 * LC1 – LC6 (`docs/phase-38-refactorisation-de-la-page.md`). */
export interface ViewLifecycle {
  /** The edit secret now, renewed by a rotation; none for another role. */
  editSecret(): Uint8Array | undefined;
  /** The role's secret, as a header, under the secret of now (LC6). */
  roleSecret(): string;
  /** The link this view holds now, for the keyring (KR-23). */
  currentLink(): string;
  linksOf(secret: Uint8Array): Promise<Record<Role, string>>;
  /** The edit secret an earlier page left pending a rotation (R-B4). */
  readonly pending: Uint8Array | undefined;
  /** A rotation accepted by the server (`onRenewed`). */
  renewed(secret: Uint8Array): Promise<void>;
  /** The server refused the link (`onRefused`). */
  refused(code: number): void;
  /** The expiry learned at an authentication (`onExpiry`). */
  setExpiry(at: number | null): void;
  /** « Renouveler les liens », through the open connection. */
  renew(connection: Pick<DocumentConnection, "rotate">): Promise<void>;
  /** The share panel, built: renewed links go to it (LC1). The secret
   * renewed while it was being built, if any, to show it again. */
  setSharePanel(panel: SharePanel): Uint8Array | undefined;
  /** The document open: its expiry and deletion in the menu (LC4, LC5). */
  opened(options: {
    expiry: HTMLElement;
    danger: HTMLElement;
    connection: Pick<DocumentConnection, "setExpiry" | "deleteDocument">;
    readOnly(): void;
  }): void;
}

export function followLifecycle(options: {
  link: LinkFragment;
  documentId: string;
  storage: Storage | undefined;
  keyring: DocumentKeyring | undefined;
  documentLinks: typeof documentLinks;
  /** Where the share links lead, read when needed. */
  linkBase(): string;
  onEditLink?(links: Record<Role, string>): void;
  confirm(message: string): boolean;
  showNotice(text: string, reload?: boolean): void;
  /** Changes not sent yet, for the refusal message. */
  unsent(): number;
}): ViewLifecycle {
  const { link, documentId: docId, storage, keyring, showNotice } = options;
  const keyringFailed = (error: unknown) => console.warn("keyring", error);
  // The edit secret this view authenticates with; renewed by a rotation
  // (ADR-0019 §5), possibly one kept by an earlier page (R-B4).
  let editSecret = link.role === "edit" ? link.secret : undefined;
  let renewedWhileOpening = false;
  let sharePanel: SharePanel | undefined;
  const linksOf = (secret: Uint8Array) =>
    options.documentLinks(options.linkBase(), docId, link.key, secret);
  const secretNow = () =>
    link.role === "edit" && editSecret ? editSecret : link.secret;
  // The link this view holds now (the edit one renewed by a rotation),
  // for the keyring (KR-23).
  const currentLink = () => {
    const url = new URL(options.linkBase());
    url.search = "";
    url.searchParams.set("doc", docId);
    url.hash = formatLinkFragment({
      key: link.key,
      role: link.role,
      secret: secretNow(),
    });
    return url.href;
  };
  const pending =
    link.role === "edit" && storage ? pendingSecret(storage, docId) : undefined;
  const renewed = async (secret: Uint8Array) => {
    editSecret = secret;
    if (storage) forgetPendingSecret(storage, docId);
    const links = await linksOf(secret);
    // A later rotation's links win, even if they were computed first.
    if (secret !== editSecret) return;
    // Accepted by the server (KR-23): kept already if this tab rotated
    // (TR2), not if an earlier page did (R-B4).
    void keyring?.opened(links.edit).catch(keyringFailed);
    options.onEditLink?.(links);
    if (sharePanel) sharePanel.setLinks(links, true);
    else renewedWhileOpening = true;
  };
  // The document's expiry, and its section once the view is up.
  let expiresAt: number | null = null;
  // Filled once the view is up; the expiry may come before.
  let lifecycle: DocumentLifecycle | undefined;
  // Deleted (ADR-0024): the text stays, read-only, once the editor is up.
  let deleted = false;
  let markDeleted: () => void = () => {};
  const refused = (code: number) => {
    void keyring?.refused(currentLink(), code).catch(keyringFailed);
    if (code === CloseCode.Deleted) {
      deleted = true;
      markDeleted();
      showNotice(refusalMessage(code));
      return;
    }
    if (code === CloseCode.UnsupportedVersion) {
      showNotice(refusalMessage(code), true);
      return;
    }
    showNotice(
      options.unsent() > 0
        ? t().refusedWithUnsent(refusalMessage(code))
        : refusalMessage(code),
    );
  };
  return {
    editSecret: () => editSecret,
    roleSecret: () => roleSecretHeader(link.role, secretNow()),
    currentLink,
    linksOf,
    pending,
    renewed,
    refused,
    setExpiry: (at) => {
      expiresAt = at;
      lifecycle?.setExpiry(at);
    },
    renew: async (connection) => {
      if (!storage) {
        showNotice(t().cannotRenew);
        return;
      }
      try {
        await renewLinks(
          docId,
          connection,
          storage,
          // TR2: the new edit link in « Mes documents » before the
          // rotation goes.
          keyring &&
            (async (secret) => {
              try {
                await keyring.keep((await linksOf(secret)).edit);
              } catch (error) {
                showNotice(t().keyringRotationHeld);
                throw error;
              }
            }),
        );
      } catch (error) {
        // The outcome is found out by the next connection (R-B4).
        console.warn("rotation", error);
      }
    },
    setSharePanel: (panel) => {
      sharePanel = panel;
      return renewedWhileOpening ? editSecret : undefined;
    },
    opened: ({ expiry, danger, connection, readOnly }) => {
      const shown = createDocumentLifecycle(expiry, {
        role: link.role,
        expiresAt,
        now: () => Date.now(),
        confirm: (message) => options.confirm(message),
        setExpiry: (inSeconds) => connection.setExpiry(inSeconds),
        deleteDocument: () => connection.deleteDocument(),
        dangerParent: danger,
      });
      lifecycle = shown;
      markDeleted = () => {
        readOnly();
        shown.deleted();
      };
      if (deleted) markDeleted();
    },
  };
}
