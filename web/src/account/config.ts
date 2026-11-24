/** What the page is told of its deployment, at `/config.json`: the gateway's
 * origin, if
 * there is one, the fingerprints of the attestation keys it trusts
 * (docs/protocol/06-identity.md, ID-26), and the organisation's name
 * (« Identité <name> »). Any other answer, or none, is neither: the page
 * works without. */

export interface PageConfig {
  gateway?: string;
  /** Lowercase hexadecimal, 64 characters each; absent if none. */
  attestationKeys?: string[];
  /** 1 to 64 characters, shown as they are (`page::org_name_shown`). */
  orgName?: string;
  /** The server takes images (ADR-0057 §6): its limits, in bytes of blobs. */
  attachments?: { imageBytes: number; documentBytes: number };
  /** The server posts notifications (ADR-0060): its VAPID public key, a
   * 65-byte uncompressed P-256 point (W-65). */
  push?: { vapidKey: Uint8Array };
}

const bytes = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;

function attachmentsOf(value: unknown): PageConfig["attachments"] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const { imageBytes, documentBytes } = value as Record<string, unknown>;
  return bytes(imageBytes) && bytes(documentBytes)
    ? { imageBytes, documentBytes }
    : undefined;
}

function pushOf(value: unknown): PageConfig["push"] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const { vapidKey } = value as Record<string, unknown>;
  if (typeof vapidKey !== "string" || !/^[A-Za-z0-9_-]{87}$/.test(vapidKey))
    return undefined;
  const bytes = Uint8Array.from(
    atob(vapidKey.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0),
  );
  return bytes.length === 65 && bytes[0] === 4
    ? { vapidKey: bytes }
    : undefined;
}

const FINGERPRINT = /^[0-9a-f]{64}$/;

/** Control characters, and the invisible formatting ones (zero widths,
 * bidirectional overrides) that would make another text appear around a
 * name: the server refuses them too. */
const INVISIBLE = /[\p{Cc}\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/u;

export function orgNameOf(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  const length = [...name].length;
  const shown =
    length >= 1 &&
    length <= 64 &&
    name.trim() === name &&
    !INVISIBLE.test(name);
  return shown ? name : undefined;
}

function originOf(gateway: unknown): string | undefined {
  if (typeof gateway !== "string") return undefined;
  try {
    const url = new URL(gateway);
    // An origin, and only that: the server writes it so (`page::Config`).
    const isOrigin =
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.origin === gateway;
    return isOrigin ? gateway : undefined;
  } catch {
    return undefined;
  }
}

export async function readPageConfig(
  apiBase: string,
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<PageConfig> {
  return (await fetchPageConfig(apiBase, fetchFn)) ?? {};
}

/** As `readPageConfig`, but `undefined` if the server gave no
 * configuration (unreachable, another status, not a JSON object), apart
 * from one that names nothing (« Lire depuis le serveur »). */
export async function fetchPageConfig(
  apiBase: string,
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<PageConfig | undefined> {
  try {
    const response = await fetchFn(new URL("/config.json", apiBase).href);
    if (response.status !== 200) return undefined;
    const value: unknown = await response.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const fields = value as Record<string, unknown>;
    const gateway = originOf(fields.gateway);
    const keys = Array.isArray(fields.attestationKeys)
      ? fields.attestationKeys.filter(
          (key): key is string =>
            typeof key === "string" && FINGERPRINT.test(key),
        )
      : [];
    const orgName = orgNameOf(fields.orgName);
    const attachments = attachmentsOf(fields.attachments);
    const push = pushOf(fields.push);
    return {
      ...(gateway && { gateway }),
      ...(keys.length > 0 && { attestationKeys: keys }),
      ...(orgName && { orgName }),
      ...(attachments && { attachments }),
      ...(push && { push }),
    };
  } catch {
    return undefined;
  }
}
