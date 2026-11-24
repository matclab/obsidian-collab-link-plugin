/** The page of `/auth-return` (ADR-0041, points 1 and 4; ID-25): reads
 * its fragment once and erases it, passes a return of the right form to
 * the tabs of the origin, and closes. Anything else is passed to no one:
 * a tab takes a return only for its attempt in progress anyway (CN1). */
import { readSignInReturn } from "../../lib/src/index.js";
import { t } from "../i18n/index.js";
import { SIGN_IN_CHANNEL } from "./channels.js";

/** What the page takes from its window (`src/auth-return.ts`). */
export interface ReturnPage {
  hash: string;
  pathname: string;
  replaceAddress(url: string): void;
  post(channel: string, data: unknown): void;
  close(): void;
  say(text: string): void;
}

/** `true` if a return was passed on. */
export function forwardSignInReturn(page: ReturnPage): boolean {
  const read = readSignInReturn(page.hash);
  // Out of the address, the history and the page's view at once.
  if (page.hash.startsWith("#")) page.replaceAddress(page.pathname);
  if (!read) {
    page.say(t().signInReturnNothing);
    return false;
  }
  page.post(SIGN_IN_CHANNEL, { ...read });
  page.say(t().signInReturnDone);
  page.close();
  return true;
}
