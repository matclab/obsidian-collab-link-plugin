// A key that signs synchronously (`node:crypto`), for the generated
// journals of the budgets and the bench (`ScenarioOptions.signer`): Node
// only, never in the page.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type { ScenarioSigner } from "./scenario.js";

export function nodeScenarioSigner(documentId = "bench"): ScenarioSigner {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = new Uint8Array(
    Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url"),
  );
  return {
    documentId,
    publicKey: raw,
    fingerprint: new Uint8Array(createHash("sha256").update(raw).digest()),
    sign: (message) => new Uint8Array(sign(null, message, privateKey)),
  };
}
