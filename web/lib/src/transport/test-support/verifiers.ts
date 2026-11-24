import { createHash, hkdfSync } from "node:crypto";
import type { Role } from "../../crypto/role-secrets.js";

/** The verifier of ADR-0019 §2, synchronous (node:crypto): for fake
 * servers, which answer within the call that sends them a message. */
export function verifierSync(role: Role, secret: Uint8Array): string {
  return createHash("sha256")
    .update(`obsidian-collab/verifier/v1\0${role}\0`)
    .update(secret)
    .digest("base64url");
}

/** The secret of `role` derived from the edit secret (ADR-0019 §2). */
export function roleSecretSync(edit: Uint8Array, role: Role): Uint8Array {
  if (role === "edit") return edit;
  return new Uint8Array(
    hkdfSync(
      "sha256",
      edit,
      new Uint8Array(0),
      `obsidian-collab/${role}/v1`,
      32,
    ),
  );
}

/** The three verifiers of the links derived from `edit`, base64url. */
export function verifiersSync(edit: Uint8Array): Record<Role, string> {
  return {
    read: verifierSync("read", roleSecretSync(edit, "read")),
    suggest: verifierSync("suggest", roleSecretSync(edit, "suggest")),
    edit: verifierSync("edit", edit),
  };
}
