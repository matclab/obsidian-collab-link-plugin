// Links of documents for the keyring's tests: a secret per (document,
// role, n), never the same for two — the keyring keeps links by their
// secret (docs/protocol/05-keyring.md, KR-20), as real, random secrets
// are. Tests only.
import { bytesToBase64Url } from "../../crypto/role-secrets.js";

const KEY = bytesToBase64Url(new Uint8Array(32).fill(0xa0));

export function testSecret(doc: string, role: string, n = 0): Uint8Array {
  const secret = new Uint8Array(32).fill(0x5a);
  const name = new TextEncoder().encode(`${doc}|${role}|${n}`);
  if (name.length > 32) throw new Error(`too long for a test secret: ${doc}`);
  secret.set(name);
  return secret;
}

export function testLink(
  doc: string,
  role = "edit",
  n = 0,
  page = "https://h/",
): string {
  return `${page}?doc=${doc}#k=${KEY}&r=${role}.${bytesToBase64Url(testSecret(doc, role, n))}`;
}
