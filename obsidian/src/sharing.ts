import {
  type App,
  Notice,
  type RequestUrlParam,
  type RequestUrlResponse,
  type TFile,
} from "obsidian";
import { createDocument, type openLink } from "../../web/lib/src/index.js";
import { PSEUDONYM_KEY, t, wikilinksIn } from "../../web/src/embed.js";
import type { DocumentLeafView } from "./leaf-view.js";
import type { LinkStore } from "./link-store.js";
import type { LinkedNotes } from "./linked-notes.js";
import type { LiveViews } from "./live-views.js";
import { readLooseHeader } from "./note-header.js";
import type { PluginSettings } from "./plugin-settings.js";
import type { PluginStorage } from "./plugin-storage.js";
import { creationFetch, requestFetch } from "./server.js";
import { shareNote } from "./share.js";
import { type UnlinkedNotes, vaultResolver } from "./vault-links.js";
import { applyEdits, toAddresses } from "./wikilinks.js";

/** What sharing needs of the plugin. */
export interface SharingHost {
  app: App;
  settings: PluginSettings;
  storage: PluginStorage;
  links: LinkStore;
  views: LiveViews<DocumentLeafView>;
  unlinked: UnlinkedNotes;
  /** The vault's linked notes, by their document (LN1–LN3). */
  index: LinkedNotes;
  request(param: RequestUrlParam): Promise<RequestUrlResponse>;
  /** The brief connection of a share. */
  connect: typeof openLink;
  /** `documentId` was just created by a share (KR-24). */
  shared(documentId: string): void;
  /** Said once, without the system's keyring. */
  sayIfNoKeyring(): void;
}

/** "Share this note": a new document with the note's text, the link kept, the
 * note its export, open in the view. Nothing is written to the note unless all
 * of that worked. */
export async function share(host: SharingHost, file: TFile): Promise<void> {
  const { app, links } = host;
  const request = (param: RequestUrlParam) => host.request(param);
  const server = host.settings.serverChosen();
  if (!server.ok) {
    new Notice(server.notice);
    return;
  }
  const auth = host.settings.auth();
  const text = await app.vault.read(file);
  // Refused by the server's name and password: its answer to the creation.
  let denied = false;
  const creation = async (param: RequestUrlParam) => {
    const response = await request(param);
    if (response.status === 401) denied = true;
    return response;
  };
  let shared: Awaited<ReturnType<typeof shareNote>>;
  try {
    shared = await shareNote({
      text,
      server: server.origin,
      author: host.storage.getItem(PSEUDONYM_KEY) ?? t().anonymous,
      create: () =>
        createDocument(server.origin, creationFetch(creation, auth)),
      connect: (url) => host.connect(url),
      keep: (documentId, editLink) => {
        links.set(documentId, editLink);
        host.shared(documentId);
      },
      rewrite: (fn) => app.vault.process(file, fn),
      // Its links to linked notes as their addresses, to itself as
      // `[[#…]]`.
      links: (text) =>
        applyEdits(text, toAddresses(text, vaultResolver(app, file, links))),
      // ADR-0057 §9: its images of the vault, attached.
      images: {
        read: async (linkpath) => {
          const dest = app.metadataCache.getFirstLinkpathDest(
            linkpath,
            file.path,
          );
          if (!dest) return undefined;
          const bytes = await app.vault.readBinary(dest);
          return { name: dest.name, bytes: new Uint8Array(bytes) };
        },
        fetch: requestFetch(request, auth),
      },
    });
  } catch (error) {
    new Notice(
      denied
        ? t().pluginShareDenied
        : t().pluginShareFailed(
            error instanceof Error ? error.message : String(error),
          ),
    );
    return;
  }
  if (!shared.ok) {
    new Notice(t().pluginShareChanged);
    return;
  }
  if (shared.kept.length > 0)
    new Notice(t().pluginImagesKept(shared.kept.join(", ")));
  host.sayIfNoKeyring();
  host.unlinked.forget(shared.documentId);
  // The links to it in the linked notes open here.
  await convertIncoming(host, file);
  await app.workspace.getLeaf(false).setViewState({
    type: "markdown",
    state: { file: file.path },
    active: true,
  });
}

/** A note just shared: the `[[…]]` to it in the other linked notes become its
 * address — in those whose view is open, by their document; the others are
 * counted, for the command to do when they are opened. */
async function convertIncoming(host: SharingHost, shared: TFile) {
  const { app, views } = host;
  let converted = 0;
  let later = 0;
  for (const file of await host.index.linked()) {
    if (file.path === shared.path) continue;
    const { document, content } = readLooseHeader(
      await app.vault.cachedRead(file),
    );
    if (document === undefined) continue;
    // Open here: its document, which its file follows a moment late.
    const view = views.live(document);
    const done =
      view?.file?.path === file.path ? view.convertLinks() : undefined;
    if (done !== undefined) {
      converted += done;
      continue;
    }
    const linksToIt = wikilinksIn(content).some(
      (link) =>
        app.metadataCache.getFirstLinkpathDest(
          link.target.split("#")[0] ?? "",
          file.path,
        )?.path === shared.path,
    );
    if (linksToIt) later += 1;
  }
  if (converted > 0 || later > 0) {
    new Notice(t().pluginIncomingLinks(converted, later));
  }
}
