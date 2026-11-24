/** The message of an object of any kind, from its fields as a record
 * (docs/protocol/06-identity.md, §6.5): one entry for what reads objects
 * generically — the vectors, the client independent of this one. */
import {
  type MessageContext,
  type SignedKind,
  annotationMessage,
  decisionMessage,
  peerMessage,
  presenceMessage,
  replyMessage,
  subscriptionMessage,
  versionMessage,
} from "./messages.js";

export function messageOf(
  context: MessageContext,
  kind: SignedKind,
  id: unknown,
  fields: Record<string, unknown>,
): Uint8Array | undefined {
  const f = fields as never;
  switch (kind) {
    case "annotation":
      return annotationMessage(context, id, f);
    case "reply":
      return replyMessage(context, id, f);
    case "decision":
      return decisionMessage(context, id, f);
    case "version":
      return versionMessage(context, id, f);
    case "peer":
      return peerMessage(context, id, fields.name);
    case "presence":
      return presenceMessage(context, id, f);
    case "subscription":
      return subscriptionMessage(context, id, f);
  }
}
