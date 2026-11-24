export { registerOnFirstEdit } from "../../lib/src/index.js";
export {
  HISTORY_ROOTS,
  type NamedVersion,
  deleteVersion,
  listVersions,
  nameVersion,
  peerNames,
  registerPeers,
} from "../../lib/src/index.js";
export {
  type DiffSegment,
  diffVersions,
  restoreText,
  textAt,
} from "./text.js";
export {
  DEFAULT_PAUSE_SECONDS,
  type VersionChange,
  type VersionGroup,
  groupVersions,
} from "./versions.js";
export {
  type AnnotatedText,
  annotatedText,
  annotatedTextAt,
} from "./annotated-text.js";
export {
  type AuthorRun,
  type Insertion,
  type Person,
  UNKNOWN_PERSON,
  authorRuns,
  authors,
  insertionAt,
  personOf,
  personOrder,
} from "./authorship.js";
