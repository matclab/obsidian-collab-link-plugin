import { CloseCode } from "../../lib/src/index.js";
import { t } from "../i18n/index.js";
import type { LocalStatus } from "./open-document.js";

/** What the page says when the server closes the connection for good
 * (ADR-0019 §4). */
export function refusalMessage(code: number): string {
  switch (code) {
    case CloseCode.Unauthenticated:
      return t().refusedUnauthenticated;
    case CloseCode.Deleted:
      return t().refusedDeleted;
    case CloseCode.Revoked:
      return t().refusedRevoked;
    case CloseCode.Forbidden:
      return t().refusedForbidden;
    case CloseCode.UnsupportedVersion:
      return t().refusedVersion;
    default:
      return t().refusedOther(code);
  }
}

/** What the page says when it keeps nothing on this device (ADR-0022). */
export function localStatusMessage(status: LocalStatus): string | undefined {
  switch (status) {
    case "persisted":
      return undefined;
    case "other-tab":
      return t().localOtherTab;
    case "unreadable":
      return t().localUnreadable;
    case "unavailable":
      return t().localUnavailable;
  }
}
