/** Signing what a page writes in one document (docs/protocol/06-identity.md,
 * §6.4, §6.5): a seal for each kind of object, made from its
 * draft, with the key of the moment. A seal that can't be made is none:
 * the object is written unsigned, never held back (ID-16: unsigned is
 * what every object was before). */
import type { LoroDoc } from "loro-crdt";
import type { Proposal } from "../annotations/decisions.js";
import type {
  AnnotationDraft,
  ReplyDraft,
  Seal,
} from "../annotations/model.js";
import type { VersionDraft } from "../history/tables.js";
import type { PresenceSealed } from "../presence/presence.js";
import type { SubscriptionFields } from "../push/subscriptions.js";
import {
  annotationMessage,
  decisionMessage,
  peerMessage,
  presenceMessage,
  replyMessage,
  subscriptionMessage,
  versionMessage,
} from "./messages.js";
import { type Signer, addIdentity, sign } from "./signature.js";

export interface DocumentSigning {
  /** The `doc` of the document's link (§6.5). */
  documentId: string;
  /** The key to sign with now; `undefined`: nothing is signed (no key on
   * this device, no Ed25519 in this browser). Read at each object: a
   * keyring opened meanwhile brings its own. */
  signer(): Promise<Signer | undefined>;
  /** An attestation of `publicKey` valid now, if this page holds one
   * (ID-38): asked for the key that signed, after it signed (AT2). */
  attestation?(publicKey: Uint8Array): Uint8Array | undefined;
  /** Resolves when what a person writes under their name may be signed
   * (decision 20: the page may first ask to sign in). Never for a name
   * in `peers` nor the presence, which typing and opening write. */
  beforeSigning?(): Promise<void>;
  /** The page's clock, in milliseconds: an object that waited for the
   * question is dated when it is signed. */
  now?(): number;
}

/** Signs with the key of the moment, or gives nothing; a dated object
 * (`attested`) takes that key's attestation, if any (ID-38, ID-39). What
 * a person writes under their name (`asked`) waits for the question
 * first (decision 20). */
async function sealWith(
  signing: DocumentSigning | undefined,
  build: (context: {
    documentId: string;
    signer: Uint8Array;
  }) => Uint8Array | undefined,
  attested = false,
  asked = attested,
  /** Dates the object anew, before it is signed. */
  redate?: (at: number) => void,
): Promise<Seal | undefined> {
  if (!signing) return undefined;
  if (asked) {
    await signing.beforeSigning?.();
    // Not seen by anyone yet: dated now, after the question and the
    // sign-in it may have brought — else dated before the attestation
    // that sign-in brings, it would only be signed (ID-39).
    if (signing.now) redate?.(signing.now());
  }
  try {
    const signer = await signing.signer();
    if (!signer) return undefined;
    const sig = await sign(signer, (fingerprint) =>
      build({ documentId: signing.documentId, signer: fingerprint }),
    );
    const attestation = attested
      ? signing.attestation?.(signer.publicKey)
      : undefined;
    return { sig, signer, ...(attestation && { attestation }) };
  } catch {
    return undefined;
  }
}

export function sealAnnotation(
  signing: DocumentSigning | undefined,
  draft: AnnotationDraft,
): Promise<Seal | undefined> {
  return sealWith(
    signing,
    (context) => annotationMessage(context, draft.id, draft.fields),
    true,
    true,
    (at) => {
      draft.fields.createdAt = at;
    },
  );
}

export function sealReply(
  signing: DocumentSigning | undefined,
  draft: ReplyDraft,
): Promise<Seal | undefined> {
  return sealWith(
    signing,
    (context) =>
      replyMessage(context, draft.id, {
        annotation: draft.annotationId,
        ...draft.fields,
      }),
    true,
    true,
    (at) => {
      draft.fields.createdAt = at;
    },
  );
}

export function sealVersion(
  signing: DocumentSigning | undefined,
  draft: VersionDraft,
): Promise<Seal | undefined> {
  return sealWith(
    signing,
    (context) => versionMessage(context, draft.id, draft.fields),
    true,
    true,
    (at) => {
      draft.fields.at = at;
    },
  );
}

/** A seal for each of `peers` under `name`; those that couldn't be made
 * are missing. */
export async function sealPeers(
  signing: DocumentSigning | undefined,
  peers: readonly string[],
  name: string,
): Promise<Map<string, Seal>> {
  const seals = new Map<string, Seal>();
  for (const peer of peers) {
    const seal = await sealWith(signing, (context) =>
      peerMessage(context, peer, name),
    );
    if (seal) seals.set(peer, seal);
  }
  return seals;
}

/** `LocalDecisions`' seal: the signer's key goes into the annotations doc,
 * committed, before the record is signed (ID-12). Rejects when there is
 * no seal: the record leaves unsigned. */
export function decisionSealer(
  signing: DocumentSigning,
  annotationsDoc: LoroDoc,
): (proposal: Proposal) => Promise<Uint8Array> {
  return async (proposal) => {
    const seal = await sealWith(
      signing,
      (context) =>
        decisionMessage(context, proposal.proposalId, {
          annotation: proposal.annotationId,
          decision: proposal.decision,
          author: proposal.author,
          ...(proposal.change && { change: proposal.change }),
        }),
      false,
      true,
    );
    if (!seal) throw new Error("not signed");
    if (addIdentity(annotationsDoc, seal.signer)) annotationsDoc.commit();
    return seal.sig;
  };
}

/** `Presence`' seal (ID-11): its `sig`, and the key, which it carries. */
export function presenceSealer(
  signing: DocumentSigning,
): (
  state: PresenceSealed,
) => Promise<{ sig: Uint8Array; pk: Uint8Array } | undefined> {
  return async ({ key, ...fields }) => {
    const seal = await sealWith(signing, (context) =>
      presenceMessage(context, key, fields),
    );
    return seal && { sig: seal.sig, pk: seal.signer.publicKey };
  };
}

/** A subscription's seal (D-41, ID-9), under its key in `subscriptions`:
 * none without a key, and then no entry — an unsigned one is never used
 * (D-42). Not under a name: no question first. */
export function sealSubscription(
  signing: DocumentSigning | undefined,
  key: string,
  fields: SubscriptionFields,
): Promise<Seal | undefined> {
  return sealWith(signing, (context) =>
    subscriptionMessage(context, key, fields),
  );
}
