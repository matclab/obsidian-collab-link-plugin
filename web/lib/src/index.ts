// obsidian-collab-client: the reference implementation of the protocol
// (docs/protocol/), without a page — what the official web client uses,
// and what another client (an Obsidian plugin, a script) can use.
//
// It implements the complete profile (docs/protocol/04-obligations.md):
// connecting gives a client that publishes only its own operations,
// resumes from its confirmed cursors and compacts safely. The groups below
// follow the profiles, to say what a client of each needs; a client that
// writes nothing simply never writes into its documents.
//
// The only entry: nothing outside imports a module of `lib/src` directly
// (checked by `boundary.test.ts`).

// --- Every client (reader) -------------------------------------------

export {
  PROTOCOL_VERSION,
  CloseCode,
  MAX_MESSAGE_BYTES,
  FRAME_OVERHEAD,
  MAX_EXPIRY_SECONDS,
  mayPublish,
} from "./transport/protocol.js";
export type { ChannelName } from "./transport/protocol.js";
export { ConnectionRefused, connectDocument } from "./transport/client.js";
export type {
  ConfirmedRecord,
  ConnectOptions,
  DecisionsConnection,
  DocumentConnection,
} from "./transport/client.js";
export { realWebSocketFactory } from "./transport/socket.js";
export type { SocketFactory, SocketLike } from "./transport/socket.js";
export {
  type LinkFragment,
  formatLinkFragment,
  parseLinkFragment,
} from "./crypto/link-fragment.js";
export {
  decrypt,
  encrypt,
  exportKeyToBase64Url,
  generateKey,
  importKeyFromBase64Url,
} from "./crypto/aead.js";
export {
  ROLES,
  type Role,
  base64UrlToBytes,
  bytesToBase64Url,
  isRole,
} from "./crypto/role-secrets.js";
export type {
  Annotation,
  AnnotationStatus,
  AnnotationType,
  Reply,
} from "./annotations/model.js";
export {
  annotationAnchor,
  listAnnotations,
  resolveAnnotation,
} from "./annotations/model.js";
export type { RangeAnchor } from "./annotations/anchor.js";
export { anchorRange, resolveRange } from "./annotations/anchor.js";
// A cursor from another peer, resolved only if safe (D-37).
export { CONTENT_TEXT, resolveCursor } from "./cursor.js";
// A Loro panic: the document it hit is poisoned (phase 9, L4).
export { isWasmTrap } from "./transport/fatal.js";
export type {
  ConfirmedProposal,
  Decision,
  Proposal,
} from "./annotations/decisions.js";
export { DecisionLog, decodeProposal } from "./annotations/decisions.js";
export type { AnnotationsView } from "./annotations/annotation-index.js";
export {
  AnnotationIndex,
  computeAnnotationsView,
} from "./annotations/annotation-index.js";
export type {
  ConflictPair,
  OverlapKind,
  ResolvedRange,
} from "./annotations/overlap.js";
export {
  classifyOverlap,
  findCreationConflict,
  findCrossingConflicts,
} from "./annotations/overlap.js";
export {
  computeActiveConflicts,
  watchConflicts,
} from "./annotations/conflicts.js";
export type {
  DetachedPreview,
  DetachedVerdict,
} from "./annotations/detached.js";
export {
  checkDetachedChange,
  previewDetachedChange,
  suggestionPeer,
} from "./annotations/detached.js";
export {
  HISTORY_ROOTS,
  type NamedVersion,
  listVersions,
  peerNames,
  readVersionEntries,
} from "./history/tables.js";
export {
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_INTERVAL_MS,
  PRESENCE_TIMEOUT_MS,
  Presence,
  type RemotePresence,
} from "./presence/presence.js";
export { EDITOR_ORIGIN } from "./origins.js";
export {
  type OpenLinkOptions,
  type OpenedLink,
  openLink,
} from "./open-link.js";

// --- Text editor: writing text and annotations ------------------------

export type {
  AnnotationDraft,
  CreateAnnotationInput,
  CreateAnnotationResult,
  DraftAnnotationResult,
  ReplyDraft,
  ReplyInput,
  Seal,
} from "./annotations/model.js";
export {
  createAnnotation,
  draftAnnotation,
  draftReply,
  idsWithStatus,
  readAnnotationEntry,
  replyToAnnotation,
  tryCreateAnnotation,
  tryDraftAnnotation,
  updateStatus,
  writeAnnotation,
  writeReply,
} from "./annotations/model.js";
export {
  MAX_SUGGESTION_BYTES,
  MAX_TEXT_BYTES,
  SuggestionTooLarge,
  TextTooLarge,
  createDetachedChange,
} from "./annotations/detached.js";
export {
  type AdditionInput,
  draftAddition,
  suggestAddition,
} from "./annotations/actions.js";
export {
  type VersionDraft,
  deleteVersion,
  draftVersion,
  nameVersion,
  peerSignature,
  registerPeers,
  writeVersion,
} from "./history/tables.js";
export {
  type Registration,
  registerOnFirstEdit,
} from "./history/register.js";

// --- Complete: decisions, effects, links, lifecycle -------------------

export type { Outcome } from "./annotations/decisions.js";
export { LocalDecisions, encodeProposal } from "./annotations/decisions.js";
export type { Adopt } from "./annotations/actions.js";
export {
  applyDecisionEffects,
  watchDecisionEffects,
} from "./annotations/actions.js";
export {
  deriveRoleSecrets,
  generateEditSecret,
  verifier,
  verifiers,
} from "./crypto/role-secrets.js";
export {
  type CreatedDocument,
  createDocument,
  documentLinks,
} from "./links/links.js";
export {
  forgetPendingSecret,
  pendingSecret,
  renewLinks,
} from "./links/renew-links.js";

// --- Attached images: encrypted, kept by the server (§1.12, ADR-0057) ---

export {
  decryptAttachment,
  encryptAttachment,
  isAttachmentId,
  newAttachmentId,
} from "./attachments/crypto.js";
export {
  type ImageFormat,
  MEDIA_TYPES,
  imageFormat,
} from "./attachments/format.js";
export { stripMetadata } from "./attachments/metadata.js";
export {
  type UploadOutcome,
  UnexpectedAnswer,
  downloadAttachment,
  roleSecretHeader,
  uploadAttachment,
} from "./attachments/http.js";
export {
  type OpenedImage,
  type PreparedImage,
  type Unprepared,
  openImage,
  prepareImage,
} from "./attachments/image.js";

// --- Keyring: a person's list of links, kept by the server -------------
// Outside the profiles (docs/protocol/05-keyring.md): for a client that
// offers « Mes documents ». The server stores an opaque blob; these
// encrypt, merge and keep it in step.

export {
  type KeyringCredentials,
  KEYRING_LINK_PREFIX,
  decryptKeyring,
  encryptKeyring,
  formatKeyringLink,
  keyringVerifier,
  newKeyringSecrets,
  parseKeyringLink,
} from "./keyring/crypto.js";
export {
  type KeyringEntry,
  type KeyringState,
  excludeDocument,
  listKeyring,
  newKeyringDoc,
  noteCreated,
  noteDeleted,
  noteOpened,
  noteRefused,
  readKeyringPlaintext,
  rememberLink,
  removeDocument,
} from "./keyring/model.js";
export {
  type KeyringTransport,
  type SyncOptions,
  type SyncOutcome,
  syncKeyring,
} from "./keyring/sync.js";
export {
  type CreatedKeyring,
  createKeyring,
  deleteKeyring,
  depositPairing,
  httpKeyringTransport,
  takePairing,
} from "./keyring/http.js";
export {
  type PairingAddress,
  UnreadableDeposit,
  formatPairingAddress,
  newPairingKey,
  openPairing,
  readPairingAddress,
  sealPairing,
} from "./keyring/pairing.js";
// The keyring of an account, kept by a gateway (§5.12).
export {
  SignedOut,
  depositAccountPairing,
  formatAccountKey,
  httpAccountKeyringTransport,
  openAccountPairing,
  parseAccountKey,
  sealAccountPairing,
  takeAccountPairing,
} from "./keyring/account.js";

// --- Identity: signing what one writes under one's name ----------------
// Outside the profiles (docs/protocol/06-identity.md): a client that signs
// and verifies; one that doesn't ignores every field these write.
export {
  type Canonical,
  decodeCanonical,
  encodeCanonical,
} from "./identity/cbor.js";
export {
  ATTESTATIONS,
  type Attestation,
  type RevocationList,
  addAttestation,
  attests,
  newerList,
  readAttestationEntry,
  readRevocationBody,
  revocationOf,
} from "./identity/attestation.js";
export {
  accountKey,
  registerKey,
  requestAttestation,
} from "./gateway/attestation.js";
export {
  type IdentityKey,
  exportPrivateKey,
  fingerprintOf,
  formatShortFingerprint,
  generateIdentityKey,
  importIdentityKey,
  isAcceptablePublicKey,
  publicKeyFingerprint,
} from "./identity/keys.js";
export {
  type AnnotationFields,
  type DecisionFields,
  type MessageContext,
  type PresenceFields,
  type ReplyFields,
  type SignedKind,
  type VersionFields,
  annotationMessage,
  decisionMessage,
  peerMessage,
  presenceMessage,
  replyMessage,
  versionMessage,
} from "./identity/messages.js";
export { messageOf } from "./identity/message-of.js";
export {
  type KnownKey,
  type Signer,
  addIdentity,
  knownKey,
  readIdentities,
  sign,
  signerOf,
  verify,
} from "./identity/signature.js";
export {
  type DocumentSigning,
  decisionSealer,
  presenceSealer,
  sealAnnotation,
  sealPeers,
  sealReply,
  sealSubscription,
  sealVersion,
} from "./identity/document-signing.js";
export {
  LATE_AFTER_MS,
  type NameKey,
  type PresenceSource,
  SignatureIndex,
  type SignatureView,
  type Verdict,
  replyKey,
} from "./identity/signature-index.js";
export {
  type KeyringIdentity,
  keyringIdentity,
  setKeyringIdentity,
} from "./keyring/identity.js";
export { addOwnKey, ownKeys } from "./keyring/own-keys.js";
export { MAX_BLOB_BYTES as MAX_KEYRING_BYTES } from "./keyring/limits.js";
// Signing in with a gateway (§6.7): the attempt, its return, the token.
export {
  type GatewaySession,
  type SignInAttempt,
  type SignInReturn,
  TOKEN_MS,
  challengeOf,
  endGatewaySession,
  exchangeSignInCode,
  gatewayHealthy,
  newSignInAttempt,
  readGatewaySession,
  OBSIDIAN_RETURN_ACTION,
  readObsidianReturn,
  readSignInMessage,
  readSignInReturn,
  signInAddress,
} from "./gateway/sign-in.js";

// --- For a client that keeps its documents between sessions ----------
// Local storage is outside the specification, but a client that has one
// needs these (docs/protocol/04-obligations.md, O-12, O-13).

export type { ChannelState, TransportState } from "./transport/client.js";
export { importHistory } from "./transport/import-history.js";

// --- Notifications: Web Push, by the server (§1.13, §3.11, ADR-0060) ---
// Outside the profiles: a client that subscribes writes its signed entry;
// one that replies or rejects encrypts for the recipients' subscriptions
// and has the server post. One that doesn't ignores `subscriptions`.

export {
  NotificationTooLong,
  RECORD_BYTES,
  encryptNotification,
} from "./push/encrypt.js";
export {
  NOTIFICATION_LIMITS,
  type NotificationMessage,
  encodeNotification,
  readNotification,
} from "./push/message.js";
export {
  SUBSCRIPTIONS,
  type SubscriptionEntry,
  type SubscriptionFields,
  readSubscriptions,
  removeSubscription,
  subscriptionKey,
  verifiedSubscriptions,
  writeSubscription,
} from "./push/subscriptions.js";
export { type RecipientQuery, recipientsOf } from "./push/recipients.js";
export {
  NOTIFICATION_TTL,
  type PushOutcome,
  postNotification,
} from "./push/http.js";

// --- Instrumentation: work counters and timing marks ------------------

export type { CounterName } from "./perf/counters.js";
export {
  count,
  countDuring,
  counter,
  counters,
  resetCounters,
} from "./perf/counters.js";
export {
  enableMarks,
  measureSince,
  resetTimings,
  span,
  timings,
} from "./perf/marks.js";
