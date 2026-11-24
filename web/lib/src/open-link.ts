import { LoroDoc } from "loro-crdt";
import { DecisionLog } from "./annotations/decisions.js";
import { importKeyFromBase64Url } from "./crypto/aead.js";
import { parseLinkFragment } from "./crypto/link-fragment.js";
import type { Role } from "./crypto/role-secrets.js";
import {
  type DocumentConnection,
  assertSecureUrl,
  connectDocument,
} from "./transport/client.js";
import {
  type SocketFactory,
  realWebSocketFactory,
} from "./transport/socket.js";

/** A document opened from its link, without a page. */
export interface OpenedLink {
  documentId: string;
  role: Role;
  /** The text: `content.getText("content")`. Write into it and commit;
   * the connection publishes what this client wrote, and only that. */
  content: LoroDoc;
  /** The annotations, and the history tables (docs/protocol/03-document.md,
   * §3.4): read them with `listAnnotations(content, annotations)`. */
  annotations: LoroDoc;
  /** The confirmed decisions, a gapless prefix of the journal: winners
   * with `winner` (suggestions) and `resolution` (comments). */
  decisions: DecisionLog;
  /** Publishing a decision, renewing the links, deleting, the expiry. */
  connection: DocumentConnection;
  /** Resolves once the server acknowledged everything this client wrote
   * so far: closing before that loses what isn't. */
  whenPublished(): Promise<void>;
  close(): void;
}

export interface OpenLinkOptions {
  /** The server's base URL (`https://host`). By default, the link's
   * origin: the server serves the page (docs/protocol/02-links-and-
   * encryption.md, K-3). */
  server?: string;
  /** How to open a WebSocket: the platform's by default (browsers, Node
   * 22 and later). */
  socketFactory?: SocketFactory;
  /** Called when the server closes the connection for good, once open. */
  onRefused?: (code: number) => void;
}

/** Opens the document of `link` (`<page>?doc=<id>#k=<key>&r=<role>.<secret>`):
 * reads the key and the role's secret from the fragment, connects, and
 * resolves once the text, the annotations and the decisions so far are
 * imported. Throws, connecting to nothing, on a link it can't read. It
 * applies no effect of decisions: an editor that wants to calls
 * `watchDecisionEffects` (docs/protocol/04-obligations.md, O-30). */
export async function openLink(
  link: string,
  options: OpenLinkOptions = {},
): Promise<OpenedLink> {
  const url = new URL(link);
  const documentId = url.searchParams.get("doc");
  if (!documentId) throw new Error("the link names no document (?doc=)");
  const { key: keyMaterial, role, secret } = parseLinkFragment(url.hash);
  const server = new URL(options.server ?? url.origin);
  const scheme = server.protocol === "http:" ? "ws:" : "wss:";
  const path = options.server ? server.pathname.replace(/\/$/, "") : "";
  const socketUrl = `${scheme}//${server.host}${path}/ws`;
  assertSecureUrl(socketUrl);
  const key = await importKeyFromBase64Url(keyMaterial);

  const content = new LoroDoc();
  const annotations = new LoroDoc();
  const decisions = new DecisionLog();
  const waiting = new Set<() => void>();
  // biome-ignore lint/style/useConst: read by `onAcked`, which may run before `connectDocument` resolves.
  let connection: DocumentConnection | undefined;
  const published = () => {
    const state = connection?.persisted();
    return (
      state !== undefined &&
      state.decisions.outbox.length === 0 &&
      state.channels.every(
        ({ own, adopted }) => own.length === 0 && adopted.length === 0,
      )
    );
  };
  const acked = () => {
    if (!published()) return;
    for (const resolve of waiting) resolve();
    waiting.clear();
  };
  connection = await connectDocument({
    url: socketUrl,
    documentId,
    key,
    credentials: { role, secret },
    channels: [
      { channel: "content", doc: content },
      { channel: "annotations", doc: annotations },
    ],
    decisions: { onConfirmed: (batch) => decisions.add(batch) },
    socketFactory: options.socketFactory ?? realWebSocketFactory,
    onAcked: acked,
    ...(options.onRefused && { onRefused: options.onRefused }),
  });
  return {
    documentId,
    role,
    content,
    annotations,
    decisions,
    connection,
    whenPublished: () =>
      published()
        ? Promise.resolve()
        : new Promise((resolve) => waiting.add(resolve)),
    close: () => connection.close(),
  };
}
