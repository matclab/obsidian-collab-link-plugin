import { t } from "../i18n/index.js";

/** Where the pseudonym is kept. */
export const PSEUDONYM_KEY = "obsidian-collab:pseudonym";
const STORAGE_KEY = PSEUDONYM_KEY;

/** The longest pseudonym, like a name in the peers table. */
const MAX_PSEUDONYM = 200;

/** ADR-0008: a local pseudonym, entered once and remembered in the
 * browser — same storage pattern as the session key, but a plain string
 * rather than key material. Asked by `ask` (a dialog) the first
 * time only; changed from the page (`savePseudonym`, phase 7 decision 9).
 * Not verified, not a real identity — purely a display convention, and
 * the page says so. */
export async function ensurePseudonym(
  ask: () => Promise<string | null>,
  storage: Storage,
): Promise<string> {
  const existing = storedPseudonym(storage);
  if (existing) return existing;
  const entered = (await ask())?.trim();
  const pseudonym = entered ? entered.slice(0, MAX_PSEUDONYM) : t().anonymous;
  storage.setItem(STORAGE_KEY, pseudonym);
  return pseudonym;
}

/** The pseudonym kept in this browser, if any: asks nothing (a read
 * link writes nothing that carries a name). */
export function storedPseudonym(storage: Storage): string | undefined {
  return storage.getItem(STORAGE_KEY) ?? undefined;
}

/** Stores `name`, trimmed, as this browser's pseudonym and returns it; or
 * `undefined`, storing nothing, if it is empty or longer than 200
 * characters. Pages already open elsewhere keep theirs until reloaded. */
export function savePseudonym(
  name: string,
  storage: Storage,
): string | undefined {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PSEUDONYM) return undefined;
  storage.setItem(STORAGE_KEY, trimmed);
  return trimmed;
}

/** The name this browser shows and signs with: signed in, the identity's
 * — whatever pseudonym was chosen before; signed out, or an identity
 * without a name, the pseudonym (analysis 18o.2, 2026-10-20). Attested
 * or not, a name is only a claim: the « vérifié » mark alone vouches for
 * it. */
export function authorOf(
  pseudonym: string,
  identityName: string | undefined,
): { name: string; fromIdentity: boolean } {
  const name = identityName?.trim().slice(0, MAX_PSEUDONYM);
  return name
    ? { name, fromIdentity: true }
    : { name: pseudonym, fromIdentity: false };
}
