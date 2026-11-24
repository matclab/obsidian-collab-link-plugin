export type { AnnotationsView } from "./annotation-index.js";
export {
  AnnotationIndex,
  computeAnnotationsView,
} from "./annotation-index.js";
export type { RangeAnchor } from "./anchor.js";
export { anchorRange, resolveRange } from "./anchor.js";
export type { Adopt } from "./actions.js";
export {
  applyDecisionEffects,
  suggestAddition,
  watchDecisionEffects,
} from "./actions.js";
export type { ConfirmedProposal, Decision, Proposal } from "./decisions.js";
export type { Outcome } from "./decisions.js";
export {
  DecisionLog,
  LocalDecisions,
  decodeProposal,
  encodeProposal,
} from "./decisions.js";
export { computeActiveConflicts, watchConflicts } from "./conflicts.js";
export type { DetachedPreview, DetachedVerdict } from "./detached.js";
export {
  MAX_SUGGESTION_BYTES,
  MAX_TEXT_BYTES,
  SuggestionTooLarge,
  TextTooLarge,
  checkDetachedChange,
  createDetachedChange,
  previewDetachedChange,
  suggestionPeer,
} from "./detached.js";
export type {
  Annotation,
  AnnotationStatus,
  AnnotationType,
  CreateAnnotationInput,
  CreateAnnotationResult,
  Reply,
  ReplyInput,
} from "./model.js";
export {
  createAnnotation,
  listAnnotations,
  replyToAnnotation,
  resolveAnnotation,
  tryCreateAnnotation,
  updateStatus,
} from "./model.js";
export type { ConflictPair, OverlapKind, ResolvedRange } from "./overlap.js";
export {
  classifyOverlap,
  findCreationConflict,
  findCrossingConflicts,
} from "./overlap.js";
