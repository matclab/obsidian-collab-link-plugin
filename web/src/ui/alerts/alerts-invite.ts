/** The invitation to be notified (NI1 – NI3): offered once I
 * published in the view, of what is left to turn on; once per document
 * while this device isn't notified there, and, without Web Push, once
 * for the device. Pure, but for the list kept in `storage`. */
import type { DeviceNotificationState } from "../../push/device.js";
import type { AlertPermission } from "./alerts.js";

/** This device in this document, as the menu knows it: `pending` until
 * the server and the browser say whether they offer it, `checking` while
 * the browser is asked. Only what this device has: a gesture's outcome is
 * apart (`DeviceAttempt`), never taken for it. */
export type DeviceOffer =
  | DeviceNotificationState
  | "unsupported"
  | "pending"
  | "checking";

/** The last gesture on this device: `busy` while it goes, then why it
 * failed, if it did, until the next one. */
export type DeviceAttempt = "idle" | "busy" | "refused" | "no-key";

export interface InviteFacts {
  documentId: string;
  /** I wrote an annotation or a reply in this view (NI1). */
  written: boolean;
  permission: AlertPermission;
  device: DeviceOffer;
  attempt: DeviceAttempt;
  /** The documents where the invitation was answered, newest first. */
  answered: readonly string[];
}

export interface InviteOffer {
  browser: boolean;
  device: boolean;
}

export function inviteOffer(facts: InviteFacts): InviteOffer | undefined {
  if (!facts.written) return undefined;
  // Unknown yet, or changing: said once settled.
  if (["pending", "checking"].includes(facts.device)) return undefined;
  if (facts.attempt === "busy") return undefined;
  const browser = facts.permission === "default";
  // Tried and failed: not offered again.
  const device =
    facts.device === "off" &&
    facts.attempt === "idle" &&
    facts.permission !== "denied";
  if (!browser && !device) return undefined;
  if (facts.answered.includes(facts.documentId)) return undefined;
  // The permission alone is the device's, settled by any answer.
  if (!device && facts.answered.length > 0) return undefined;
  return { browser, device };
}

export const NOTIFY_INVITES_KEY = "obsidian-collab:notify-invites";
const KEPT = 100;

export function answeredInvites(storage: Storage | undefined): string[] {
  try {
    const list: unknown = JSON.parse(
      storage?.getItem(NOTIFY_INVITES_KEY) ?? "[]",
    );
    return Array.isArray(list)
      ? list.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

export function rememberInvite(
  storage: Storage | undefined,
  documentId: string,
): void {
  const list = [
    documentId,
    ...answeredInvites(storage).filter((id) => id !== documentId),
  ];
  try {
    storage?.setItem(NOTIFY_INVITES_KEY, JSON.stringify(list.slice(0, KEPT)));
  } catch {
    // Storage refused: invited again at the next publication.
  }
}
