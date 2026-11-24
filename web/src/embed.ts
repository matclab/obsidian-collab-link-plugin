// The page's entry for another host: the Obsidian plugin
// (docs/phase-14-plugin-obsidian.md, decision 2) reaches the page's code
// only through here (`embed.test.ts`). A view opens in an element of the
// host's; several may share a window.
export {
  type DocumentTarget,
  type DocumentViewEnvironment,
  type MountedView,
  PREFERENCE_KEYS,
  mountDocumentView,
} from "./app/document-view.js";
export type { EditorFactory } from "./editor/editor.js";
export {
  type DocumentLinkRange,
  type WikilinkRange,
  documentLinksIn,
  wikilinksIn,
} from "./editor/link-ranges.js";
export { openDocument } from "./app/open-document.js";
export { documentIdentity } from "./app/document-identity.js";
export {
  type IdentityKeys,
  identityKeys,
  openDeviceKeyStore,
} from "./identity/identity-keys.js";
export {
  type KeyringEnvironment,
  sessionOptions,
} from "./keyring/environment.js";
export { KeyringSession } from "./keyring/session.js";
export { type HomeView, mountHome } from "./keyring/home.js";
export { ACCOUNT_CHANNEL, SIGN_IN_CHANNEL } from "./account/channels.js";
export {
  type PageConfig,
  fetchPageConfig,
  orgNameOf,
  readPageConfig,
} from "./account/config.js";
export { importMarkdown } from "./criticmarkup/import.js";
export type { HeadingTarget } from "./outline/resolve.js";
export { PSEUDONYM_KEY } from "./identity/pseudonym.js";
export {
  type KeyringLock,
  openKeyringLocal,
  webKeyringLock,
} from "./keyring/local.js";
export { type DocumentLock, webLocks } from "./storage/index.js";
export { documentTitle } from "./ui/document-title.js";
export type { AlertPermission, Attention } from "./ui/alerts/alerts.js";
export {
  LANGUAGE_KEY,
  chooseLanguage,
  setLanguage,
  t,
} from "./i18n/index.js";
