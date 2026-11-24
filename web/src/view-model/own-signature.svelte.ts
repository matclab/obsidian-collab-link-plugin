/** What this browser signs with, and why it doesn't carry the name yet
 *: the popup of one's own comment « signed » says it.
 * Set by the document view from its identity line; read by
 * `SignatureMark` through the context its panel is mounted with. */
export class OwnSignature {
  /** The short fingerprint of the key this browser signs with. */
  short = $state<string | undefined>(undefined);
  /** Why what it signs doesn't carry the name, while signed in; none
   * otherwise. */
  reason = $state<string | undefined>(undefined);
}

/** The key of the context `OwnSignature` is given under. */
export const OWN_SIGNATURE = Symbol("own-signature");
