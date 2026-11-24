import { pluralFor } from "./plural.js";

const plural = pluralFor("en");

/** Every text the page shows, in English. The
 * French one has the same keys, checked by the compiler. A text built from
 * values is a function; a count goes through `plural`. */
export const en = {
  // ------------------------------------------------------------ page
  refusedUnauthenticated:
    "Invalid or revoked link, or the document was deleted.",
  refusedDeleted:
    "This document was deleted from the server. What you see is the copy kept in this browser, to read and copy.",
  refusedRevoked: "This link was revoked: ask an editor for the new one.",
  refusedForbidden: "Access denied.",
  refusedVersion:
    "The server was updated and speaks another protocol version: reload the page.",
  refusedOther: (code: number) => `The server closed the connection (${code}).`,
  refusedWithUnsent: (refusal: string) =>
    `${refusal} Changes not sent yet are kept in this browser: open the new link to send them.`,
  localOtherTab:
    "This document is open in another tab: what this tab hasn't sent is lost when it closes.",
  localUnreadable:
    "A local copy of this document can't be read here: it is left as is, and this tab keeps nothing on this device.",
  localUnavailable:
    "This browser keeps nothing on this device: what isn't sent is lost when the tab closes.",
  unsentTitle:
    "Kept in this browser only until sent. A private window loses them when it closes.",
  invalidEntries: (count: number) =>
    `${count} unreadable ${plural(count, { one: "entry", other: "entries" })} ignored`,
  invalidLink: "Invalid link: it carries no key or no role secret.",
  pastedLinkConverted:
    "Link pasted without its key: only people who already have that document can open it from the text. The full link is kept in your documents. “Paste with the key” gives access to everyone who reads this text.",
  pastedLinkNotKept:
    "Link pasted without its key: only people who already have that document can open it from the text. This browser keeps no list of your documents: keep the link elsewhere. “Paste with the key” gives access to everyone who reads this text.",
  keepFullLink: "Paste with the key",
  pastedLinkGone:
    "The pasted text has changed since: paste the link again to put it back with its key.",
  keylessAbsent:
    "This address names a document that isn't in your documents: ask whoever gave it to you for its link.",
  keylessUnchecked:
    "This address names a document that isn't in this device's copy of your documents, and the list couldn't be checked: try again once online.",
  keylessNoList:
    "This address names a document without its key, and this browser keeps no list of your documents: ask for its link, or open your list here.",
  createNeedsServer:
    "Creating a document needs the server: it can't be reached.",
  internalError:
    "Internal error: reload the page. What wasn't sent is kept in this browser. If the error comes back after reloading, this document holds an entry this version can't read.",
  saveFailed:
    "Saving on this device failed: what isn't sent is lost when the tab closes.",
  cannotRenew: "Cannot renew links: this browser keeps no local storage.",
  downloadTrace: "Download trace",

  close: "Close",
  documentText: "Document text",
  startWriting:
    "Start writing here. Type / for a heading, a list, a table…; the ? of the toolbar explains the rest. A first heading names the document.",
  emptyDocument: "This document is empty.",
  untitled: "Untitled document",
  syncSaved: "Saved",
  syncSavedTitle: "The server holds every change made here.",
  syncSending: "Sending…",
  syncOffline: "Offline — kept on this device",

  // ------------------------------------------------------------ name
  chooseName: "Your name",
  continue: "Continue",
  dismiss: "Dismiss",
  reload: "Reload",
  choosePseudonym: "Choose a display name for your comments and suggestions:",
  anonymous: "anonymous",
  yourName: "Your name",
  save: "Save",
  cancel: "Cancel",
  nameLength: "A name is 1 to 200 characters.",
  nameOfIdentity:
    "Your identity's name, while you are signed in. Signed out, this browser takes its own name back.",
  nameNote:
    "A display name, not verified: anyone can choose any name. New comments and suggestions carry it; earlier ones keep theirs.",

  // ------------------------------------------------------------ presence
  nobodyElse: "Nobody else here.",
  hereNow: "Here now:",
  namesNotVerified: "Names are chosen by each person, not verified.",

  // ------------------------------------------------------------ my documents
  // (the user never reads « keyring »)
  homeTitle: "Collaborative documents",
  newDocument: "New document",
  myDocuments: "My documents",
  myDocumentsIntro:
    "Keep the list of the documents you open, on all your devices: no account, a key that only you hold.",
  keepMyDocuments: "Keep my documents",
  findMyDocuments: "Find my documents",
  findMyDocumentsIntro:
    "On another device, paste your My documents key: the list opens here too.",
  myDocumentsKey: "My documents key",
  openList: "Open",
  keyInvalid: "This is not a My documents key.",
  keyNotFound: "No list matches this key on this server.",
  keyUnreadable: "This key doesn't open the list kept on this server.",
  keyRevealTitle: "Your My documents key",
  keyRevealNote:
    "Keep it in a password manager: it opens every document of the list. Never share it, never send it.",
  keyKept: "I have kept it",
  showKey: "Show the My documents key",
  noDocumentsYet: "No document yet: the documents you open will appear here.",
  filterList: "Filter",
  sortBy: "Sort by",
  sortRecent: "Last opened",
  sortTitle: "Title",
  openedOn: (date: string) => `Opened ${date}`,
  stateRenewed: "Link renewed: ask for the new one, then paste it here.",
  stateDeleted: "Deleted from the server.",
  newLink: "New link",
  linkNotThisDocument: "This link is not this document's.",
  saveLink: "Keep",
  removeFromList: "Remove",
  removeConfirm:
    "Remove this document from My documents? Opening its link again won't add it back.",
  keyringOffline:
    "The server can't be reached: the list shown is the one kept on this device.",
  keyringGone:
    "This list no longer exists on the server. Its copy on this device is kept.",
  keyringRecreate: "Keep it under a new key",
  keyringFull: "My documents is full: remove documents to keep new ones.",
  keyringUnreadableServer:
    "The list kept on the server can't be read with this key: the copy on this device is kept.",
  keyringSuperseded:
    "Another tab opened another list on this device: reload the page.",
  keyringUnavailable:
    "This browser keeps nothing on this device: My documents isn't available here.",
  keyringRotationHeld:
    "The links weren't renewed: the new link couldn't be kept in My documents.",
  changeKey: "Change the key",
  changeKeyConfirm:
    "Change the key of My documents? The current key stops opening the list: on your other devices, you will paste the new one.",
  keyChanged:
    "Key changed. On your other devices, paste this new key when they ask for it.",
  oldKeyStillOpens:
    "The old key couldn't be revoked yet: it still opens the list until this device reaches the server again.",
  keyringGoneNewKey:
    "If you changed its key on another device, paste the new key: this device's copy joins it.",
  keyringUnsaved:
    "This device couldn't keep the list: it will try again at the next synchronisation.",
  signInReturnDone: "Sign-in passed to the page: you can close this window.",
  signInReturnNothing: "This page only serves the return of a sign-in.",
  signIn: "Sign in",
  signInPending: "Signing in…",
  signInCancel: "Cancel",
  signToNameTitle: "Sign in to sign with your name?",
  signToNameBody:
    "What you write is signed with this device's key. Signed in, it also shows the name your organisation gives you, which the others can check.",
  signToNameSignedInTitle: "Sign with your name?",
  signToNameConfirmBody:
    "Your identity needs confirming for what you write to carry your name, verified. The sign-in window will ask for your password again.",
  signToNameSignIn: "Sign in",
  signToNameWithout: "Continue without",
  /** « Identité Systerel : Ada Lovelace (ada@…) ». */
  identityLabel: (org: string | undefined, who: string) =>
    `${org ? `${org} identity` : "Identity"}: ${who}`,
  signOut: "Sign out",
  signInDenied: "Sign-in refused.",
  signInFailed: "Sign-in failed: try again.",
  signInExpired: "Your session has expired: sign in again.",
  signInWindowNote:
    "A window opens on your organisation's sign-in page. If nothing opens, allow pop-up windows for this site.",
  // ------------------------------------------------------------ identity
  /** « Identité Systerel », or « Identité » without a name. */
  identityOf: (org: string | undefined) =>
    org ? `${org} identity` : "Identity",
  /** Who signed in: the name, and the address if there is one. */
  identityWho: (name: string, email: string | null) =>
    email ? `${name} (${email})` : name,
  /** « votre identité Systerel, Ada Lovelace (ada@…) ». */
  yourIdentity: (org: string | undefined, who: string) =>
    `your ${org ? `${org} ` : ""}identity, ${who}`,
  associatedFuture: (identity: string) =>
    `The documents you create or open in this browser will be associated with ${identity}.`,
  associateQuestion: (count: number, identity: string) =>
    `Associate ${plural(count, { one: "this document", other: `these ${count} documents` })} with ${identity}?`,
  associateMore: (count: number) =>
    `and ${count} ${plural(count, { one: "other", other: "others" })}`,
  associate: "Associate",
  /** Another identity's list on this browser. */
  otherIdentityQuestion: (
    count: number,
    other: string | undefined,
    identity: string,
  ) =>
    `This browser keeps ${count} ${plural(count, { one: "document", other: "documents" })} of another identity${other ? ` (${other})` : ""}, signed in here before. Associate ${plural(count, { one: "it", other: "them" })} with ${identity}?`,
  associateOther: "Associate with your identity",
  identityChooseHome: "Choose what to do with it, on the home page",
  forgetOther: "Don't keep them here",
  forgetOtherNote:
    "Not kept here, they stay in the other identity's list, which finds them by signing in.",
  /** A caret's tooltip: its name, verified or not. */
  cursorVerified: (name: string) => `${name} (verified name)`,
  cursorNotVerified: (name: string) => `${name} (name not verified)`,
  identityAttested: "What you write carries your name.",
  identityNotYet: "What you write doesn't carry your name yet:",
  identityAssociate:
    "associate the documents of this browser with your identity",
  identityOpenHere:
    "open your list of documents in this browser, once: from a device where it is open, or with its key",
  identityConfirm: "Confirm your identity",
  identityInMenu: "See the identity in the Document menu.",
  identityRefused:
    "Your organisation no longer attests this browser's key: what you write doesn't carry your name.",
  newSigningKey: "New signing key",
  newSigningKeyExplains:
    "What you write next will carry your name again. What the old key signed stays as it is.",
  newSigningKeyOffline:
    "Offline: your list couldn't sync. Try again once online.",
  identityChipNewKey: "Key refused · New key",
  identityOther:
    "This browser's list belongs to another identity: what you write doesn't carry your name.",
  identityUnconfirmed:
    "Your identity could not be confirmed with the gateway: what you write doesn't carry your name yet.",
  identityRetry: "Try again",
  identityChipRetry: "Identity not confirmed · Try again",
  identityChipCancel: "Signing in… · Cancel",
  identityChipAssociate: "Your documents to associate",
  identityChipOpenHere: "Open your list here",
  identityChipOther: "Another identity's documents",
  homeLastStep:
    "Last step: confirm your identity for your comments to carry your name.",
  associateLater: "Later",
  associateAgain: (count: number) =>
    `Associate ${plural(count, { one: "the document", other: `the ${count} documents` })} of this browser with your identity`,
  attachNeedsKey:
    "Your list of documents already exists, opened on another device or browser. Signing in is not enough to open it here: it is encrypted by a key only your devices hold. Open it once in this browser: on a device where it is open, choose « Add a device » and scan the code, or paste its key here. Until then, the documents opened here are kept on the server, waiting, and will join it.",
  startOverIntro:
    "No device where it is open any more, nor its key? Start a new list: it replaces the old one for your identity, and this browser's list goes into it. The old list is lost: its documents are found only by their links, or from a device where it is still open, which can merge it into the new one.",
  startOver: "Start a new list",
  startOverConfirm:
    "Start a new list for your identity? The old one can no longer be opened with your sign-in. Your identity will be confirmed by signing in again.",
  startedOver:
    "New list started. Keep its key, below: it, or the code of « Add a device », opens the list on your other devices.",
  homeKeptByIdentity: (identity: string) =>
    `Your documents are kept with ${identity}: on another device, sign in and open the list there once, with the code of « Add a device » or its key.`,
  homeKeptByIdentitySignedOut:
    "Your documents are kept with your identity: sign in to find them up to date.",
  homeKeptByKey:
    "Your documents are kept with your key: paste it, or scan the code of « Add a device », to find them on another device.",
  homeKeptNowhere:
    "This browser doesn't keep your documents: you find them only by their link.",
  homeModesTitle: "How are your documents kept?",
  homeModeIdentity:
    "With your identity, when you are signed in: the list is kept on the server for your identity. On each new device or browser, open it once, with the code of « Add a device » or its key; then, signing in is enough.",
  homeModeKey:
    "With a key, without an account: the key is yours alone; lost, so is the list.",
  homeModeNone:
    "With nothing: each document is found by its link, which you keep yourself.",
  homeModesPrivate:
    "In every case, the server can read neither your documents nor their list: that is why no one can give you back a list whose key you lost.",
  homeKeyWarningLead: "Important:",
  homeKeyWarning:
    "neither the server, nor your organisation, nor your sign-in can open your list again: it is encrypted by a key only your devices hold. Keep that key (« Show the My documents key ») in a password manager. Lose it along with every device where the list is open, and you lose the list, and access to the documents whose link you didn't keep.",
  homeModeYours: "your case",
  accountKeyLabel: "Key of your documents",
  accountKeyWrong: "This key doesn't open your documents.",
  keyringSignedOut:
    "Sign in to get My documents on your other devices: until then, this list stays on this device. The documents themselves synchronise as usual.",
  keyringOtherAccount:
    "This list belongs to another identity than the one signed in: it isn't synchronised. Sign out, then sign in with its identity.",
  pairingSignInFirst: "Sign in to receive My documents from your other device.",
  addDeviceSignIn: "Sign in to add a device.",
  addDevice: "Add a device",
  pairingTitle: "Open My documents on another device",
  pairingNote:
    "Scan this code with the other device's camera, or open this link on it. It works once, for 5 minutes. Show it to no one else.",
  pairingQr: "QR code of the link that opens My documents on another device",
  pairingLink: "Link for the other device",
  pairingExpired: "This code has expired.",
  pairingNew: "New code",
  pairingDone: "Done",
  pairingTooMany: "Too many codes are waiting: use one, or wait 5 minutes.",
  pairingGone:
    "This code has expired or has already been used: ask the other device for a new one. If you didn't use it, change the key of My documents on the other device.",
  pairingUnreadable:
    "This code can't be read: ask the other device for a new one.",
  pairingMergeConfirm:
    "This device already has a list in My documents. Add its documents to the list of the code? Whoever holds that list will see them. Choose Cancel if you don't know where the code comes from.",
  pairingKeptOwn: "This device keeps its own list: the code wasn't used.",
  pairingJoined: "My documents is now on this device too.",
  pairingMerged:
    "The documents this device already listed have joined the list.",
  signedWith: (short: string) => `Signed with signing key ${short}`,
  signedNameLabel: (name: string, short: string) =>
    `${name}, signed with signing key ${short}`,
  signatureExplains:
    "Written with this key. The key says nothing of who holds it: only that what bears the same fingerprint comes from it.",
  signatureLate: (dated: string, received: string) =>
    `Dated ${dated}, received ${received}.`,
  signatureDetails: "Signature details",
  // ADR-0051: a word beside the name, what it means once opened.
  withAlert: (label: string, alert: string) => `${label}: ${alert}`,
  alertKeys: (n: number) => `${n} keys`,
  alertRevoked: "revoked",
  alertLate: "received late",
  nameKeysTitle: (name: string, n: number) =>
    `The name “${name}” is signed by ${n} keys in this document.`,
  nameKeysExplains:
    "A browser where the My documents list isn't open has its own signing key: someone who writes from two devices may have two. Otherwise, someone else may have taken this name, which isn't verified. If in doubt, ask this person for their signing key's fingerprint: their Document menu shows it.",
  thisKey: "this one",
  yourKey: "yours",
  keySignedIn: (n: number) =>
    n === 0
      ? "in no annotation"
      : `in ${n} ${plural(n, { one: "annotation", other: "annotations" })}`,
  keyRevokedExplains:
    "Your organisation withdrew this key: what is dated before stays attributed to it.",
  signatureLateExplains:
    "A device that stayed offline, or an object dated earlier than it was written.",
  signingKeyTitle: "Signing key",
  signingKeyIntro:
    "What you write from this browser is signed with this key. Its fingerprint:",
  signingKeyGive:
    "Give it to whoever wants to check that what they read comes from you: they compare it to the one the key beside your name shows. It neither reads your documents nor signs in your place.",
  signingKeyNotKeyring:
    "This isn't the My documents key, which opens your list: that one is given to no one.",
  highlight: "Bring forward",
  highlightKey: (short: string) => `Bring forward key ${short}`,
  keyBroughtForward: (short: string, n: number) =>
    `Key ${short}: ${n} ${plural(n, { one: "annotation", other: "annotations" })} brought forward`,
  previousOfKey: "Previous annotation of this key",
  nextOfKey: "Next annotation of this key",
  stopBringingForward: "Stop bringing forward",
  attestedNameLabel: (name: string, issuer: string) =>
    `${name}, verified by ${issuer}`,
  attestedAs: (name: string) => `Name attested: ${name}`,
  attestedEmail: (email: string) => `Address: ${email}`,
  attestedBy: (issuer: string) => `Attested by ${issuer}`,
  attestedValid: (from: string, to: string) =>
    `Attestation valid from ${from} to ${to}`,
  attestedExplains:
    "Your organisation attests that this key was this person's when this was dated.",
  keyRevoked: (date: string) => `Key revoked on ${date}.`,
  keepThisDocument: "Keep this document in My documents",
  keepThisDocumentNote: "Unchecked, opening it no longer adds it.",

  // ------------------------------------------------------------ share
  roleRead: "Read only",
  roleSuggest: "Comment and suggest",
  roleEdit: "Full edit",
  yourAccess: (role: string) => `Your access: ${role}`,
  share: "Share",
  linksRenewed:
    "Links renewed: every previous link is revoked. Send these new ones.",
  roleReadMay: "Read the text and the annotations.",
  roleSuggestMay: "Comment and suggest changes.",
  roleEditMay: "Change anything, decide on suggestions, manage the document.",
  shareIntro:
    "Each link carries the document's key: whoever has it opens the document with that role.",
  copied: "Copied",
  renewOpen: "Renew all links…",
  renewWarning:
    "The three current links stop working, for everyone, and everyone connected is cut off: do it if a link went where it shouldn't, then send the new ones.",
  copy: "Copy",
  renewLinks: "Renew all links",
  renewConfirm:
    "Renew all links? Everyone connected is cut off, and every current link stops working: you will have to send the three new links again.",

  // ------------------------------------------------------------ lifecycle
  document: "Document",
  deletedFromServer: "Deleted from the server.",
  keptUntilDeleted: "Kept until an editor deletes it.",
  deletedOn: (date: string, when: string) =>
    `Deleted from the server on ${date} (${when}).`,
  due: "due",
  inMinutes: (n: number) =>
    `in ${n} ${plural(n, { one: "minute", other: "minutes" })}`,
  inHours: (n: number) =>
    `in ${n} ${plural(n, { one: "hour", other: "hours" })}`,
  inDays: (n: number) => `in ${n} ${plural(n, { one: "day", other: "days" })}`,
  expireIn: "In",
  expireOn: "On",
  hours: "hours",
  days: "days",
  weeks: "weeks",
  set: "Set",
  removeExpiry: "Remove expiry",
  deleteDocument: "Delete document",
  expiryNotConfirmed:
    "The expiry was not confirmed by the server: check it once reconnected.",
  expiryTooFar: "An expiry is at most 100 years away.",
  expiryWholeNumber:
    "Enter a whole number of hours, days or weeks, at least 1.",
  expiryInFuture: "Choose a date in the future.",
  expiryConfirm: (date: string) =>
    `The document will be deleted from the server on ${date}, for everyone, and every link will stop working. Set this expiry?`,
  language: "Language",
  expiry: "Expiry",
  expiryUnit: "Unit",
  deleteWord: "delete",
  deleteTypeWord: (word: string) => `Type “${word}” to confirm`,
  deleteNote:
    "Deletes the document from the server, for everyone: every link stops working, and changes not sent yet are lost. Whoever opened it keeps a local copy in their browser.",
  notConnectedNotDeleted: "Not connected: the document was not deleted.",

  // ------------------------------------------------------------ files
  files: "Files",
  exportMd: "Export with annotations (CriticMarkup)",
  exportText: "Export the text only",
  importMd: "Import .md",
  exportOmitted: (n: number) =>
    `${n} ${plural(n, { one: "annotation", other: "annotations" })} left out (its text could not be read).`,
  exportAmbiguous:
    "Some text holds a CriticMarkup marker or a note reference, or a note's line starts with **: read back, this file may differ.",
  exportPointed: (n: number) =>
    `${n} ${plural(n, { one: "comment written as a point: its range", other: "comments written as a point: their range" })} crossed a suggestion or another comment, and won't come back.`,
  exportImagesMissing: (n: number) =>
    `${n} ${plural(n, { one: "image could not be had: it stays", other: "images could not be had: they stay" })} cited by the server's address.`,
  exportCrossing:
    "Crossing annotations cannot be written in CriticMarkup: decide on one of each pair first, or export the text alone.",
  imported: "Imported.",
  importMoved: (n: number) =>
    `${n} ${plural(n, { one: "comment", other: "comments" })} inside a proposed addition moved to its insertion point.`,
  importDropped: (n: number) =>
    `${n} ${plural(n, { one: "annotation", other: "annotations" })} dropped (empty, or inside a proposed addition).`,
  importOrphanNote: (n: number) =>
    `${n} ${plural(n, { one: "note", other: "notes" })} without a reference: a comment's discussion is now at the end of the text, a suggestion's was decided elsewhere.`,
  importDecidedOutside: (n: number) =>
    `${n} ${plural(n, { one: "suggestion decided outside the application: its note was", other: "suggestions decided outside the application: their notes were" })} ignored.`,
  importDuplicateName: (n: number) =>
    `${n} ${plural(n, { one: "name used twice: read without its note", other: "names used twice: read without their note" })} after the first.`,
  importNoNote: (n: number) =>
    `${n} ${plural(n, { one: "annotation without its note", other: "annotations without their note" })}: signed by you and dated now, or, for a comment, left out.`,
  importBareHighlight: (n: number) =>
    `${n} ${plural(n, { one: "highlight", other: "highlights" })} without a comment: kept as text.`,
  importNotEmpty: "Not imported: the document is no longer empty.",
  importFailed: (detail: string) => `Not imported: ${detail}`,

  // ------------------------------------------------------------ formatting
  formatting: "Formatting",
  constructBold: "Bold",
  constructItalic: "Italic",
  constructStrikethrough: "Strikethrough",
  constructHighlight: "Highlight",
  constructCode: "Code",
  constructLink: "Link",
  constructParagraph: "Text",
  constructHeading1: "Heading 1",
  constructHeading2: "Heading 2",
  constructHeading3: "Heading 3",
  constructHeading4: "Heading 4",
  constructHeading5: "Heading 5",
  constructHeading6: "Heading 6",
  constructBulletList: "Bulleted list",
  constructOrderedList: "Numbered list",
  constructTaskList: "Checklist",
  constructQuote: "Quote",
  constructCallout: "Callout",
  constructTable: "Table",
  constructCodeBlock: "Code block",
  constructMathBlock: "Formula",
  constructDiagram: "Diagram",
  constructRule: "Horizontal line",
  constructFootnote: "Footnote",
  constructImage: "Image",
  /** A callout's family in the / menu (ADR-0063, EN1). */
  calloutItem: (name: string) => `Callout: ${name}`,
  calloutNote: "Note",
  calloutAbstract: "Abstract",
  calloutInfo: "Info",
  calloutTodo: "Todo",
  calloutTip: "Tip",
  calloutSuccess: "Success",
  calloutQuestion: "Question",
  calloutWarning: "Warning",
  calloutFailure: "Failure",
  calloutDanger: "Danger",
  calloutBug: "Bug",
  calloutExample: "Example",
  calloutQuote: "Quote",
  keyCtrl: "Ctrl",
  keyShift: "Shift",
  keyAlt: "Alt",
  keyEscape: "Esc",
  keyTab: "Tab",
  keyEnter: "Enter",
  keyClick: "click",
  withShortcut: (name: string, keys: string) => `${name} (${keys})`,
  paragraphStyle: "Paragraph style",
  mixedStyles: "Mixed",
  moreFormatting: "More",
  insert: "Insert",
  anchorMenu: "Headings of the document",
  hideToolbar: "Hide the formatting toolbar",
  showToolbar: "Show the formatting toolbar",

  // ------------------------------------------------------------ writing help
  helpTitle: "Writing help",
  helpWriting: "Writing in Markdown",
  helpShortcuts: "Shortcuts",
  helpGoodToKnow: "Good to know",
  helpYouType: "You type",
  helpYouGet: "You get",
  helpDrawn: "Drawn in Reading",
  helpMarkup:
    "The markup shows again on the line you edit, and hides everywhere else.",
  helpSource:
    "Source shows the text as it is kept; Reading, the document as the others read it.",
  helpSlash:
    "Type / at the start of a line to insert a heading, a list, a table…",
  helpAnchor: "Type ](# or [[# in a link to choose a heading of the document.",
  helpAnnotationText:
    "Comments and replies show emphasis, lists, quotes, code and links that leave the document; not headings, tables, images, formulas, nor links inside it.",
  helpAwaiting:
    "« To answer » counts the open annotations whose last entry is someone else's; ‹ › or F8 / Shift+F8 go from one to the next in the text, « Nothing to add » sets one aside until its next reply.",
  helpSuggestAtCaret:
    "Without selecting anything, « Suggest » proposes a text at the caret (in Review, for those who can also write). At the start of a heading, an item or a quote, it asks where to add it: as a new paragraph before the line, or at the start of its text.",
  helpAnnotate: "Comment on the selection",
  helpSend: "Send a comment, a suggestion or a reply",
  helpMoveSection:
    "Move the section (its heading and its text) before the previous one or after the next",
  helpIndent: "Indent, or move a list item down a level",
  helpOutdent: "Unindent, or move a list item up a level",
  helpLeaveText: "Leave the text by keyboard, to the next field",
  helpTabMode: "Tab: indent, or move to the next field",
  helpMoveLines: "Move the lines up or down",
  helpCopyLines: "Copy the lines above or below",
  helpDeleteLine: "Delete the line",
  helpSlashMenu: "Insert a construction",
  helpUndo: "Undo",
  helpRedo: "Redo",
  helpFollow: "Open a link; go from a footnote to its text, and back",
  // ------------------------------------------------------------ first visit
  welcomeWriter:
    "This document is written in Markdown. The formatting shows as you type; the markup (**bold**, # heading…) stays visible on the line you write on. Type / to insert a heading, a list, a table.",
  welcomeSuggester:
    "You can comment on this document or suggest changes: select a passage, then choose Comment or Suggest.",
  welcomeHelp: "See the help",
  welcomeDone: "Got it",
  hintMarkup:
    "The markup shows where you write; elsewhere, the text is formatted.",
  hintDiagram: "This diagram is drawn in Reading.",
  exampleBold: "**a word**",
  exampleItalic: "*a word*",
  exampleStrikethrough: "~~a word~~",
  exampleHighlight: "==a word==",
  exampleCode: "`a code`",
  exampleLink: "[a link](https://example.org)",
  exampleHeading1: "# A heading",
  exampleHeading2: "## A subheading",
  exampleHeading3: "### A smaller one",
  exampleBulletList: "- an item\n- another",
  exampleOrderedList: "1. first\n2. second",
  exampleTaskList: "- [ ] to do\n- [x] done",
  exampleQuote: "> a quote",
  exampleCallout: "> [!note] A title\n> Its text",
  exampleTable: "| Name | Role |\n| --- | --- |\n| Ana | Author |",
  exampleCodeBlock: "```\nsome code\n```",
  exampleMathBlock: "$$\nx^2 + y^2\n$$",
  exampleDiagram: "```mermaid\nflowchart LR\n  A --> B\n```",
  exampleRule: "***",
  exampleFootnote: "A sentence[^1]\n\n[^1]: Its note.",
  exampleImage: "![A diagram](attachment:AAECAwQFBgcICQoLDA0ODw)",

  // ------------------------------------------------------------ views
  write: "Write",
  modes: "View",
  formatted: "Formatted",
  help: "Help",
  viewChoice: "Display",
  preview: "Reading",
  previewHelp:
    "The document as its readers see it: diagrams and formulas drawn, nothing to edit.",
  readOnly: "Read only",
  source: "Source",
  sideBySide: "Side by side",
  // Who wrote (ADR-0059).
  whoWrote: "Who wrote",
  whoWroteHelp:
    "Colors the text by the person who typed it: a paste or a move is whoever made it, a deletion leaves nothing to see. Names are not verified.",
  whoWroteLegend: "Who wrote the text shown",
  wroteAt: (name: string, when: string) => `${name}, ${when}`,
  everyone: (n: number) => `Everyone (${n})`,
  outline: "Outline",
  showOutline: "Show the outline",
  hideOutline: "Hide the outline",
  outlineWidth: "Outline width",
  outlineWidthHint: "Drag to resize; double-click to reset",
  outlineLevels: "Levels",
  showLevels: (count: number) =>
    `Show ${count} ${plural(count, { one: "level", other: "levels" })}`,
  collapseHeading: (text: string) => `Collapse “${text}”`,
  expandHeading: (text: string, count: number) =>
    `Expand “${text}” (${count} ${plural(count, { one: "heading", other: "headings" })} hidden)`,
  foldHint: "Alt+click: every heading at this depth",
  noHeadings: "No headings",
  task: "Task",
  quote: "Quote",
  callout: "Callout",
  wikilinkLocal: "A note in a participant's vault, not shared",
  // A remote image (ADR-0055): shown only once the reader grants it.
  remoteImageShow: "Show",
  remoteImageShowLabel: (host: string) => `Show the image from ${host}`,
  // Inserting an attached image (ADR-0057 §8).
  imageUploading: (name: string) => `Sending ${name}…`,
  imageUploadCancel: "Cancel",
  imageTooLarge: (name: string, megabytes: number) =>
    `${name} is too large: images are at most ${megabytes} MB.`,
  imageNotAnImage: (name: string) =>
    `${name} is not an image this page shows (PNG, JPEG, GIF, WebP, AVIF, SVG).`,
  imageMalformed: (name: string) => `${name} could not be read: not sent.`,
  imageDocumentFull: "This document has reached its limit of images.",
  imageRefused: "The image was refused: this link no longer allows it.",
  imageUploadFailed: (name: string) =>
    `${name} could not be sent: the server can't be reached.`,
  imageUploadAnswered: (name: string, status: number) =>
    `${name} could not be sent: the server answered ${status}.`,
  imageRefusedTooLarge: (name: string) =>
    `${name} was refused as too large (answer 413): the server, or a proxy in front of it, has a lower limit.`,
  // An image attached to the document (ADR-0057 §8), not shown yet or never.
  attachedImageLoading: "Loading the image…",
  attachedImageAbsent: "Image not in this document",
  attachedImageUnreadable: "Unreadable image",
  attachedImageUnavailable: "Image unavailable: the server can't be reached",
  remoteImageWaiting: "Being written: shown once the cursor leaves it",
  remoteImageFrom: (host: string) => `Image from ${host}`,
  remoteImagesHidden: (count: number, hosts: string) =>
    `${count} remote ${plural(count, { one: "image", other: "images" })} not shown, from ${hosts}.`,
  remoteImagesMore: (count: number) => `+${count}`,
  remoteImagesWarning:
    "Showing them tells these sites, chosen by whoever wrote the text, your address, when you read, and sometimes who you are if you are signed in there. What a participant is still typing may be requested before they finish.",
  remoteImagesShow: "Show",
  remoteImagesAlways: "Always for this document",
  remoteImagesAlwaysNote: "including images added later, by anyone",
  remoteImagesShown: "Remote images shown.",
  remoteImagesShownAlways:
    "Remote images always shown on this device for this document: images added later load too.",
  remoteImagesStop: "Stop showing",
  review: "Review",
  openCount: (n: number) =>
    `${n} open ${plural(n, { one: "annotation", other: "annotations" })}`,
  nothingLeft:
    "Nothing left to decide: every open annotation has its decision on its way.",
  history: "History",
  pendingInPreview: (n: number) =>
    `${n} pending ${plural(n, { one: "suggestion", other: "suggestions" })}, shown by marks: the text is the current one.`,
  // ------------------------------------------------------------ history
  historyNote:
    "Names are chosen by each person and not verified; dates are those of their devices.",
  noVersion: "No version yet.",
  current: "current",
  versionTitle: (title: string) => `Version: ${title}`,
  versionsTitle: "Versions",
  // The software's version, at the end of the document menu.
  appVersion: (version: string) => `Collab Link ${version}`,
  // Before a version is chosen: what one may do with it, by role.
  historyGuideEdit:
    "Choose a version: you can read it, compare it with the current text, name it, or put its text back.",
  historyGuideSuggest:
    "Choose a version: you can read it, compare it with the current text, or name it.",
  historyGuideRead:
    "Choose a version: you can read it or compare it with the current text.",
  seeVersion: "Read this version",
  compareNow: "Compare with the current text",
  isCurrentVersion: "This is the current version: nothing to compare.",
  changesLead: "What changed from this version until now:",
  wordsAdded: (n: number) =>
    `+${n} ${plural(n, { one: "word", other: "words" })}`,
  wordsRemoved: (n: number) =>
    `−${n} ${plural(n, { one: "word", other: "words" })}`,
  versionName: "Name",
  nameThisVersion: "Name this version",
  restoreThisText: "Put this text back",
  restoreHint:
    "The current text becomes this version's, for everyone; the history keeps the one before.",
  deleteThisName: "Delete this name",
  textNotArrived: "The text of this version hasn't arrived yet.",
  restoreConfirm: (label: string) =>
    `Restore the text of “${label}”? It is a new edit of the current text, for everyone: the history keeps every version, and the annotations and decisions stay as they are.`,
  restoredFrom: (label: string) => `Restored from “${label}”`,
  namedBy: (author: string, date: string) => `named by ${author}, ${date}`,
  textNotReceived: " — text not received yet",
  unknownAuthor: "unknown author",
  undated: "undated",
  versionNameLength: "A version name has 1 to 200 characters.",

  // ------------------------------------------------------------ annotations
  annotate: "Annotate",
  comment: "Comment",
  suggest: "Suggest",
  deleteSel: "Delete",
  yourComment: "Your comment",
  replaceWith: "Replace with (empty: delete)",
  addText: "Text to add",
  additionPlace: "Where to add the text",
  paragraphBefore: "New paragraph before this line",
  lineStart: "At the start of this line",
  why: "Why? (optional)",
  emptyComment: "Write a comment first.",
  nothingChanges: "Nothing changes: edit the proposed text.",
  annotations: "Annotations",
  annotationsCount: (n: number) => `Annotations (${n})`,
  annotationsInMargin: "Annotations in the margin",
  previous: "Previous",
  next: "Next",
  countOf: (i: number, n: number) => `${i} of ${n}`,
  allCount: (n: number) => `All (${n})`,
  oneAtATime: "One at a time",
  verbComment: "commented",
  verbAddition: "suggests adding",
  verbDeletion: "suggests deleting",
  verbSubstitution: "suggests replacing",
  acceptAction: "Accept",
  rejectAction: "Reject",
  resolveAction: "Resolve",
  conflictCard: "Crosses another annotation: decide one of them first.",
  noOpen: "No open annotation. Select some text to comment or suggest.",
  noOpenRead: "No open annotation.",
  annotationsFilter: "Annotations shown",
  filterOpen: (n: number) => `Open (${n})`,
  filterClosed: (n: number) => `Closed (${n})`,
  filterAll: (n: number) => `All (${n})`,
  noClosed: "No closed annotation.",
  decidedBy: (name: string) => `by ${name}`,
  textDeleted: "Text deleted",
  seeAnnotatedText: "See the annotated text",
  hideAnnotatedText: "Hide the annotated text",
  deletedOnBy: (when: string, who: string) => `deleted ${when} by ${who}`,
  deletedBy: (who: string) => `deleted by ${who}`,
  textThenUnavailable: "Earlier text unavailable",
  journalTitle: (title: string) => `${title} — annotations`,
  journalNone: "No annotation.",
  journalDate: "Date",
  journalState: "State",
  journalAnnotated: "Annotated text",
  journalUnavailable: "earlier text unavailable",
  journalProposed: "Proposed text",
  journalComment: "Comment",
  journalNote: "Note",
  journalReplies: "Replies",
  colon: ":",
  exportJournal: "Export the annotations' journal",
  statusOpen: "open",
  statusAccepted: "accepted",
  statusRejected: "rejected",
  statusResolved: "resolved",
  waitingForItsText: "waiting for its text",
  waitingForEditor: "waiting for an editor",
  pendingDecision: (decision: string) => `pending: ${decision}`,
  proposalWaiting: "(waiting for its text)",
  proposalInvalid: "(invalid change)",
  decisionLost: (author: string, decision: string) =>
    `Your decision was not retained: ${author} had already ${decision} it.`,
  accept: "accept",
  reject: "reject",
  resolve: "resolve",
  typeTextFirst: "Type the text to propose first",
  emptyDocumentAddition:
    "Nothing to anchor an addition to in an empty document",
  typeReplacementFirst: "Type the replacement first",
  conflictsWith: (id: string) => `Crosses annotation ${id}`,
  tooLargeToAccept:
    "This suggestion is too large to accept: reject it instead.",
  suggestionTooLarge:
    "This suggestion is too large: propose at most about 6 MB of text.",
  textTooLarge: "This text is too large: write at most about 6 MB.",
  reply: "Reply",
  yourReply: "Your reply",
  send: "Send",
  typeReplyFirst: "Write a reply first.",
  replyCount: (n: number) =>
    `${n} ${plural(n, { one: "reply", other: "replies" })}`,
  // What awaits my reply (ADR-0050)
  awaiting: "To answer",
  awaitingCount: (n: number) =>
    `${n} ${plural(n, { one: "annotation awaits", other: "annotations await" })} your reply`,
  nothingAwaiting: "Nothing to answer",
  previousAwaiting: "Previous annotation to answer",
  nextAwaiting: "Next annotation to answer",
  // Alerts of what awaits my reply (ADR-0060 §1)
  alertReply: (name: string, text: string) => `${name} replied: ${text}`,
  alertComment: (name: string, text: string) => `${name} commented: ${text}`,
  alertSuggestion: (name: string) => `${name} suggested a change`,
  alertsTitle: "Notifications",
  alertsOffer: "Notify me in this browser",
  alertsOfferHelp:
    "When a reply awaits yours and this document isn't in front of you. The notification shows the title, the name and the start of the text.",
  alertsOn: "Notifications are on: a reply that awaits yours is notified.",
  alertsBlocked:
    "Notifications are blocked for this site: allow them in the browser's settings.",
  pushOffer: "Notify me on this device",
  pushOfferHelp:
    "Even with the page closed: a reply to your annotations, or the rejection of your suggestions, in this document.",
  pushOn: "This device is notified, even with the page closed.",
  inviteQuestion: "Be notified when someone replies to you?",
  inviteLater: "Not now",
  inviteUndoDeviceBefore:
    "You can stop: « Stop notifying this device », in the menu",
  inviteUndoDeviceAfter:
    "at the top of the view, Notifications section, for this document; this browser's notifications, in its settings.",
  inviteUndoBrowser: "You can turn them off in the browser's settings.",
  pushStop: "Stop notifying this device",
  pushNeedsKey: "Notifying this device needs a signing key.",
  pushRefused:
    "The browser refused: allow its notifications in its settings, then try again.",
  pushGenericTitle: "Collab Link",
  pushGenericBody: "A reply awaits yours.",
  pushSomeone: "Someone",
  pushRejected: (name: string, note: string) =>
    note
      ? `${name} rejected your suggestion: ${note}`
      : `${name} rejected your suggestion`,
  setAside: "Nothing to add",
  putBack: "Put back to answer",
  walkDecide: "To decide",
  walkAwaiting: "To answer",
  walkChoice: "What the review walks through",
  nothingLeftToAnswer: "Nothing left to answer.",
  waitingForText: "waiting for text",
  // ------------------------------------------- the Obsidian plugin
  pluginOpenLink: "Open a link",
  pluginLinkTitle: "Open a document's link",
  pluginLinkLabel: "The document's link",
  pluginOpen: "Open",
  pluginNotALink: "This isn't a document's link: it names no document (?doc=).",
  pluginInsecureLink:
    "This link's server is reached without TLS: its secret would cross the network in clear. Only https, or this computer.",
  pluginLinkNeeded:
    "Paste this document's link to open it on this device: command “Open a link”.",
  pluginViewTitle: "Shared document",
  pluginOpenFailed: (reason: string) =>
    `The document could not open: ${reason}`,
  pluginModifiedOutside: (copy: string) =>
    `This note's file was changed outside the plugin. That version is kept in “${copy}”; the file is the document's export again.`,
  pluginOutsideCopy: (date: string) => `changed outside the plugin ${date}`,
  pluginResume: "Resume this change",
  pluginResumed: "The change is resumed in the document.",
  pluginResumeFailed: (reason: string) =>
    `The change could not be resumed: ${reason}`,
  pluginOpenElsewhere: "This document is already open in another tab.",
  pluginGoToTab: "Go to that tab",
  pluginUnlink: "Unlink this note",
  pluginNotLinked: "This note is not linked to a shared document.",
  pluginNoKeyring:
    "This computer has no system keyring: documents' links are kept by Obsidian unencrypted, outside the vault.",
  pluginShareNote: "Share this note",
  pluginObsidianPreview: "Obsidian preview alongside",
  pluginShareTitle: "Share this note",
  pluginShareChange:
    "From now on, write this note in the plugin's view: its file becomes a copy that the plugin rewrites. To make it an ordinary note again: “Unlink this note”.",
  pluginShareProperties:
    "Everything in the note goes to whoever has a link to it, its properties (tags, aliases…) included; its CriticMarkup becomes comments and suggestions.",
  pluginShareConfirm: "Share",
  pluginCancel: "Cancel",
  pluginNoServer:
    "Set the address of the server documents are created on, in the plugin's settings.",
  pluginBadServer:
    "The server's address in the settings is not usable: https, or http to this computer only.",
  pluginShareDenied:
    "The server refused the name or password set in the plugin's settings.",
  pluginImagesKept: (names: string) =>
    `Shared; these images of the vault stay as written, the others won't see them: ${names}.`,
  pluginShareChanged:
    "The note changed while it was shared: it is left as it is. Share it again.",
  pluginShareFailed: (reason: string) =>
    `The note could not be shared: ${reason}`,
  pluginServer: "Server",
  pluginServerDescription:
    "Where “Share this note” creates documents: https://…, or http to this computer.",
  pluginUser: "Name",
  pluginUserDescription:
    "If the server asks for one to create documents (nginx's basic authentication).",
  pluginPassword: "Password",
  pluginPasswordDescription:
    "Kept in Obsidian's secret storage, never in the plugin's settings file.",
  pluginCheckCredentials: "Test the name and password",
  pluginCheckCredentialsDescription:
    "Asks the server above whether it accepts them, without creating anything.",
  pluginCheckCredentialsButton: "Test",
  pluginCredentialsAccepted: "The server accepts this name and password.",
  pluginCredentialsRefused:
    "The server refuses this name or password: documents cannot be created with them.",
  pluginCredentialsMissing:
    "The server asks for a name and password to create documents: set them above.",
  pluginCredentialsNotAsked:
    "The server asks for no name or password: anyone who reaches it creates documents.",
  pluginServerUnreachable: (server: string) =>
    `${server} could not be reached: check the server's address, and that this computer reaches it.`,
  pluginFolder: "Folder for opened links",
  pluginFolderDescription:
    "Where “Open a link” creates the note of a document it doesn't have yet.",
  pluginMyDocuments: "My documents",
  pluginOpenFromMyDocuments: "Open a document of My documents",
  pluginOpenFromMyDocumentsPlaceholder: "A document's title",
  pluginNoMyDocuments:
    "My documents needs somewhere to keep things on this computer: Obsidian's storage is not available here.",
  pluginMyDocumentsEmpty:
    "My documents is not kept on this computer yet: open it to keep it, or to find it with its key.",
  pluginIdentity: "Identity",
  pluginGateway: "Identity gateway",
  pluginGatewayDescription:
    "Where you sign in with your organisation's account, to sign what you write with your name: https://…, or http to this computer. Given by your organisation.",
  pluginAttestationKeys: "Attestation key fingerprints",
  pluginAttestationKeysDescription:
    "One per line, as your organisation publishes them: a name is shown as verified only if the gateway's key is one of these.",
  pluginAttestationKeysBad: (line: number) =>
    `Line ${line} is not a fingerprint (64 hexadecimal digits): no name is verified until it is corrected.`,
  pluginReadFromServer: "Read from the server",
  pluginReadFromServerDescription:
    "Fills in the gateway and the fingerprints as the server above names them, for you to compare with what your organisation publishes.",
  pluginReadFromServerButton: "Read",
  pluginTrustTitle: "The server's identity gateway",
  pluginTrustGateway: (gateway: string) => `Gateway: ${gateway}`,
  pluginTrustNoGateway:
    "No gateway: no one signs in through this server, but names attested by the keys below are verified.",
  pluginTrustKeys: "Attestation key fingerprints:",
  pluginTrustCompare:
    "Compare them with what your organisation publishes before using them: whoever chooses these fingerprints chooses whose names are shown as verified.",
  pluginTrustConfirm: "Use them",
  pluginServerNamesNoGateway:
    "The server names no attestation key: there is nothing to read.",
  pluginServerUnreadable: (server: string) =>
    `No configuration could be read from ${server}: check the server's address in the settings, and that this computer reaches it.`,
  pluginNoEd25519:
    "This version of Obsidian cannot sign what you write (no Ed25519): your comments are written without a signature. Reinstall Obsidian from obsidian.md to sign them.",
  pluginMoveSectionUp: "Move the section up",
  pluginMoveSectionDown: "Move the section down",
  pluginEditor: "Editor",
  pluginEditorDescription:
    "Where a linked note is written: Obsidian's editor (its shortcuts, Vim, its formatting, other plugins' extensions), or the page's.",
  pluginEditorObsidian: "Obsidian's",
  pluginEditorPage: "The page's",
  pluginConvertLinks: "Convert the links to shared notes",
  pluginAddressUnknown:
    "This link names a shared document that isn't in this vault nor in your documents: ask for its link.",
  pluginOpenInBrowser: "Open in the browser",
  pluginConvertLinksNotEditor:
    "Only an editor of this note's document can convert its links.",
  pluginLinksConverted: (count: number) =>
    count === 0
      ? "No link to a shared note to convert."
      : `${count} ${plural(count, { one: "link", other: "links" })} to shared notes converted.`,
  pluginIncomingLinks: (converted: number, later: number) =>
    `Links to this note: ${converted} converted in the shared notes open here; ${later} ${plural(later, { one: "shared note", other: "shared notes" })} not open, to convert once opened (“Convert the links to shared notes”).`,
  pluginEditorUnavailable:
    "Obsidian's editor could not be used here (Obsidian may have changed): the note is written in the page's editor.",
  pluginVaultImages: "Attached images in the vault",
  pluginVaultImagesDescription:
    "A linked note's attached images are written to the images folder of the folder above, and its file cites them: they show outside the view, and the vault keeps a copy. Files already written stay when this is turned off.",
};

/** What a language provides: the same keys, each of the same kind. */
export type Dictionary = typeof en;
