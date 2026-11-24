/** A notification's post (docs/protocol/01-wire.md §1.13): the server
 * posts it to the subscription's push service, under the secret of a role
 * (W-54). Best effort (O-41): an answer is never an error, and nothing is
 * tried again. */

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** What a post became (W-62). */
export type PushOutcome =
  /** The push service took it (`202`). */
  | "sent"
  /** The subscription is gone (`410`): only its device repairs it. */
  | "gone"
  /** Refused by the server: no such document, a reader, a body refused,
   * a server without notifications. */
  | "refused"
  /** Beyond a limit (`429`). */
  | "limited"
  /** The push service failed or couldn't be reached (`502`), the network,
   * or an answer the specification doesn't give. */
  | "failed";

export interface PushRequest {
  endpoint: string;
  /** Seconds the push service keeps it for an absent device (O-42). */
  ttl: number;
  /** The encrypted message (K-20). */
  payload: Uint8Array;
}

/** Three days (O-42). */
export const NOTIFICATION_TTL = 259_200;

const base64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

export async function postNotification(
  apiBase: string,
  documentId: string,
  roleSecret: string,
  request: PushRequest,
  fetchFn: Fetch = fetch,
): Promise<PushOutcome> {
  let status: number;
  try {
    const response = await fetchFn(
      `${apiBase}/documents/${encodeURIComponent(documentId)}/push`,
      {
        method: "POST",
        headers: {
          "Role-Secret": roleSecret,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          endpoint: request.endpoint,
          ttl: request.ttl,
          payload: base64Url(request.payload),
        }),
      },
    );
    status = response.status;
  } catch {
    return "failed";
  }
  if (status === 202) return "sent";
  if (status === 410) return "gone";
  if (status === 429) return "limited";
  if ([400, 403, 404, 413, 415].includes(status)) return "refused";
  return "failed";
}
