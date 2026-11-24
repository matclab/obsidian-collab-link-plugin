/** An attached image over HTTP (docs/protocol/01-wire.md §1.12): its
 * upload and its download, under the secret of a role (W-54), which goes
 * in `Role-Secret` and nowhere else (K-1). Knows blobs, never the key. */
import { type Role, bytesToBase64Url } from "../crypto/role-secrets.js";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** What an upload became (W-55, W-56). */
export type UploadOutcome =
  | "stored"
  /** No such document, an erased one, or a secret that no longer opens it
   * (links renewed). */
  | "missing"
  /** Not an editor's secret. */
  | "forbidden"
  | "too-large"
  /** The document's images, or the server's, at their limit. */
  | "full"
  | "taken";

/** An answer the specification doesn't give (W-55, W-57): a server
 * misconfigured, or a proxy in front of it — reached, not lost. */
export class UnexpectedAnswer extends Error {
  constructor(readonly status: number) {
    super(`unexpected answer from the server (${status})`);
  }
}

/** `Role-Secret`'s value (W-54). */
export function roleSecretHeader(role: Role, secret: Uint8Array): string {
  return `${role}.${bytesToBase64Url(secret)}`;
}

function url(
  apiBase: string,
  documentId: string,
  attachmentId: string,
): string {
  return `${apiBase}/documents/${encodeURIComponent(documentId)}/attachments/${attachmentId}`;
}

const UPLOADS: Record<number, UploadOutcome> = {
  201: "stored",
  404: "missing",
  403: "forbidden",
  413: "too-large",
  507: "full",
  409: "taken",
};

/** Uploads a blob (W-55); throws `UnexpectedAnswer` on an answer the
 * specification doesn't give, or fetch's error on a network failure. */
export async function uploadAttachment(
  apiBase: string,
  documentId: string,
  attachmentId: string,
  roleSecret: string,
  blob: Uint8Array,
  fetchFn: Fetch = fetch,
  signal?: AbortSignal,
): Promise<UploadOutcome> {
  const response = await fetchFn(url(apiBase, documentId, attachmentId), {
    method: "PUT",
    headers: {
      "Role-Secret": roleSecret,
      "Content-Type": "application/octet-stream",
    },
    body: blob as BodyInit,
    signal,
  });
  const outcome = UPLOADS[response.status];
  if (outcome === undefined) throw new UnexpectedAnswer(response.status);
  return outcome;
}

/** Downloads a blob: `absent` for `404` (W-57), never an error of the
 * document. */
export async function downloadAttachment(
  apiBase: string,
  documentId: string,
  attachmentId: string,
  roleSecret: string,
  fetchFn: Fetch = fetch,
): Promise<Uint8Array | "absent"> {
  const response = await fetchFn(url(apiBase, documentId, attachmentId), {
    headers: { "Role-Secret": roleSecret },
  });
  if (response.status === 404) return "absent";
  if (response.status !== 200) throw new UnexpectedAnswer(response.status);
  return new Uint8Array(await response.arrayBuffer());
}
