import {
  type Role,
  bytesToBase64Url,
  deriveRoleSecrets,
  exportKeyToBase64Url,
  formatLinkFragment,
  generateEditSecret,
  generateKey,
  verifiers,
} from "../crypto/index.js";
import { PROTOCOL_VERSION } from "../transport/index.js";

export interface CreatedDocument {
  documentId: string;
  key: CryptoKey;
  /** The content key, base64url, as links carry it. */
  keyMaterial: string;
  editSecret: Uint8Array;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Creates a document (ADR-0019 §2): the client draws the content key and
 * the edit secret, and registers only the verifiers of the three role
 * secrets; the server draws the id. */
export async function createDocument(
  apiBase: string,
  fetchFn: Fetch = fetch,
): Promise<CreatedDocument> {
  const key = await generateKey();
  const editSecret = generateEditSecret();
  const all = await verifiers(editSecret);
  const response = await fetchFn(`${apiBase}/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      v: PROTOCOL_VERSION,
      verifiers: {
        read: bytesToBase64Url(all.read),
        suggest: bytesToBase64Url(all.suggest),
        edit: bytesToBase64Url(all.edit),
      },
    }),
  });
  if (response.status === 426) {
    throw new Error(
      "The server was updated and speaks another protocol version: reload the page.",
    );
  }
  if (!response.ok) {
    throw new Error(`creating a document failed (${response.status})`);
  }
  const { document_id: documentId } = (await response.json()) as {
    document_id: string;
  };
  return {
    documentId,
    key,
    keyMaterial: await exportKeyToBase64Url(key),
    editSecret,
  };
}

/** The three links of a document, recomputed from the edit secret: what
 * an editor shares (ADR-0019 §2). Based on `pageUrl`, without its query
 * nor fragment. */
export async function documentLinks(
  pageUrl: string,
  documentId: string,
  keyMaterial: string,
  editSecret: Uint8Array,
): Promise<Record<Role, string>> {
  const secrets = await deriveRoleSecrets(editSecret);
  const link = (role: Role) => {
    const url = new URL(pageUrl);
    url.search = "";
    url.searchParams.set("doc", documentId);
    url.hash = formatLinkFragment({
      key: keyMaterial,
      role,
      secret: secrets[role],
    });
    return url.toString();
  };
  return { read: link("read"), suggest: link("suggest"), edit: link("edit") };
}
