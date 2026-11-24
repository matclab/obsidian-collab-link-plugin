import type { NameKey } from "../../../lib/src/index.js";

/** The keys of a view's signed names (ADR-0051 §3, §4): mine, what each
 * signed among the annotations, the one brought forward. Set by the
 * wiring (`mine`), the annotations panel (`signed`) and a mark's details
 * (`chosen`); read by `SignatureMark` through the context its panel is
 * mounted with, by the panel and by the bar's `KeyNav`. */
export class SignerKeys {
  /** My keys' fingerprints, in hexadecimal (ADR-0050 §2). */
  mine = $state.raw<ReadonlySet<string>>(new Set());
  /** By a key's fingerprint, in hexadecimal: the annotations it signed,
   * itself or one of its replies, in the panel's order. */
  signed = $state.raw<ReadonlyMap<string, readonly string[]>>(new Map());
  /** The key whose annotations are brought forward, if any (§4). */
  chosen = $state.raw<NameKey | undefined>(undefined);
}

/** The key of the context `SignerKeys` is given under. */
export const SIGNER_KEYS = Symbol("signer-keys");
