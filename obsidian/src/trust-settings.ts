import { orgNameOf } from "../../web/src/embed.js";
import { serverOrigin } from "./server.js";

/** What the plugin trusts of a gateway (docs/phase-18-trousseau-identite.md,
 * M3): from its settings, never from the server's `/config.json` alone, since
 * the plugin's code isn't the server's (OB3). */
export interface TrustSettings {
  /** Where to sign in; absent, attested names are read, no one signs in. */
  gateway?: string;
  /** Lowercase hexadecimal, 64 characters each (ID-26); never empty. */
  attestationKeys: string[];
  /** Shown only (« Identité <name> »). */
  orgName?: string;
}

const FINGERPRINT = /^[0-9a-f]{64}$/;

/** The fingerprints as typed: one per line, blank lines ignored; else the
 * number of the first line that isn't one. */
export function readFingerprints(
  text: string,
): { ok: true; keys: string[] } | { ok: false; line: number } {
  const keys: string[] = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    const key = line.trim().toLowerCase();
    if (key === "") continue;
    if (!FINGERPRINT.test(key)) return { ok: false, line: index + 1 };
    if (!keys.includes(key)) keys.push(key);
  }
  return { ok: true, keys };
}

/** The trust of the settings, `setting` reading `data.json`; none
 * without a fingerprint, or with a line that isn't one: nothing is then
 * attested, rather than a list other than the one typed. */
export function trustSettings(
  setting: (name: string) => unknown,
): TrustSettings | undefined {
  const typed = setting("attestationKeys");
  const read = readFingerprints(typeof typed === "string" ? typed : "");
  if (!read.ok || read.keys.length === 0) return undefined;
  const gatewayText = setting("gateway");
  const gateway =
    typeof gatewayText === "string" && gatewayText.trim() !== ""
      ? serverOrigin(gatewayText)
      : undefined;
  const orgName = orgNameOf(setting("orgName"));
  return {
    ...(gateway?.ok && { gateway: gateway.origin }),
    attestationKeys: read.keys,
    ...(orgName && { orgName }),
  };
}
