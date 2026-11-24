<!-- The page's home: « Nouveau document »,
« Mes documents » when this device has them, else how to keep or find
them. Shows what `home.ts` gives it; acts through its callbacks. -->
<script lang="ts">
import type { KeyringEntry, Role } from "../../lib/src/index.js";
import AccountBar from "../account/AccountBar.svelte";
import type { AccountState } from "../account/sign-in.js";
import { currentLanguage, formatDate, t } from "../i18n/index.js";
import type { AccountOffer, IdentityStep } from "./home.js";
import { type ListSort, visibleEntries } from "./list-model.js";

interface Props {
  /** Absent in another host (the plugin): no « Nouveau document ». */
  newDocumentHref?: string;
  /** Opens an entry in the host, instead of following its address. */
  onOpenEntry?: (link: string) => void;
  /** This browser keeps things on this device. */
  available: boolean;
  onKeep: () => void;
  onFind: (key: string) => void;
  onRemove: (documentId: string) => void;
  onNewLink: (documentId: string, link: string) => void;
  onRecreate: () => void;
  onShowKey: () => void;
  onChangeKey: () => void;
  /** The key of another keyring, given on a device whose keyring is gone
   * (KR-30): its copy merges into that one. */
  onNewKey: (key: string) => void;
  onCopy: (text: string) => void;
  /** Shows a code that opens the list on another device. */
  onAddDevice: () => void;
  onPairingDone: () => void;
  onSignIn: () => void;
  onCancelSignIn: () => void;
  onSignOut: () => void;
  /** Puts this device's list in the signed-in account (KR-44). */
  onAttach: () => void;
  onLater: () => void;
  onAssociateOther: () => void;
  onForgetOther: () => void;
  /** The key of the account's list, pasted (KR-42). */
  onAccountKey: (key: string) => void;
  /** « Confirmer votre identité »: a recent sign-in, in the click. */
  onConfirmIdentity: () => void;
  /** « Réessayer »: the attestation asked again. */
  onRetryIdentity: () => void;
  /** « Nouvelle clé de signature »: the refused key replaced (NK6). */
  onNewSigningKey: () => void;
  /** « Recommencer une liste »: the identity's list, its key lost,
   * replaced by this browser's. */
  onStartOver: () => void;
}
const {
  newDocumentHref,
  onOpenEntry,
  available,
  onKeep,
  onFind,
  onRemove,
  onNewLink,
  onRecreate,
  onShowKey,
  onChangeKey,
  onNewKey,
  onCopy,
  onAddDevice,
  onPairingDone,
  onSignIn,
  onCancelSignIn,
  onSignOut,
  onAttach,
  onLater,
  onAssociateOther,
  onForgetOther,
  onAccountKey,
  onConfirmIdentity,
  onRetryIdentity,
  onNewSigningKey,
  onStartOver,
}: Props = $props();
// Unique in the window.
const uid = $props.id();

const ROLES: Record<Role, string> = {
  read: t().roleRead,
  suggest: t().roleSuggest,
  edit: t().roleEdit,
};

let hasKeyring = $state(false);
let entries = $state<KeyringEntry[]>([]);
let message = $state("");
let gone = $state(false);
let findError = $state("");
let revealed = $state<string | undefined>(undefined);
let copied = $state(false);
let busy = $state(false);
/** Signing in, where the page has a gateway that answers. */
let account = $state<AccountState>({ kind: "unavailable" });
/** What the signed-in account offers the list. */
let accountList = $state<AccountOffer>({ kind: "none" });
/** The organisation's name (`/config.json`). */
let org = $state<string | undefined>(undefined);
/** « votre identité Systerel, Ada Lovelace (ada@…) ». */
let identity = $state("");
/** The list is an account's: no key to change. */
let accountKeyring = $state(false);
let accountKeyError = $state("");
/** The list is the identity's, the name not carried yet (IC3): the step left.
 * */
let identityStep = $state<IdentityStep | undefined>(undefined);
/** The refused key's replacement couldn't sync the list (NK6). */
let newSigningKeyOffline = $state(false);
// biome-ignore lint/style/useConst: assigned by bind:this in the template.
let accountKeyInput = $state<HTMLInputElement>();
/** The code shown to add a device: its address, and its QR code. */
let pairing = $state<{ address: string; path: string; size: number }>();
let pairingOver = $state(false);
let pairingCopied = $state(false);
// biome-ignore lint/style/useConst: bound in the template.
let filter = $state("");
// biome-ignore lint/style/useConst: bound in the template.
let sort = $state<ListSort>("recent");
// biome-ignore lint/style/useConst: assigned in the template.
let newLinks = $state<Record<string, string>>({});
let newLinkErrors = $state<Record<string, string>>({});
/** What awaits my reply, per document, as the round found it (ADR-0060
 * §2). */
let awaiting = $state<Record<string, number>>({});
// biome-ignore lint/style/useConst: assigned by bind:this in the template.
let keyInput = $state<HTMLInputElement>();
// biome-ignore lint/style/useConst: assigned by bind:this in the template.
let newKeyInput = $state<HTMLInputElement>();

const shown = $derived(
  visibleEntries(entries, { filter, sort, language: currentLanguage() }),
);
const signedIn = $derived(account.kind === "signed-in");
/** Signed in, the identity's list elsewhere: this list waits to join it
 * (LA1); no key of its own to show or change. */
const waiting = $derived(signedIn && accountList.kind === "needs-key");
/** Where the documents are kept: with the identity — a list in
 * waiting too, kept on the server for it —, a key, or nowhere. */
const mode = $derived<"identity" | "key" | "none">(
  (hasKeyring && accountKeyring) || waiting
    ? "identity"
    : hasKeyring
      ? "key"
      : "none",
);
const MODES = [
  ["identity", t().homeModeIdentity],
  ["key", t().homeModeKey],
  ["none", t().homeModeNone],
] as const;

export function setAwaiting(
  documentId: string,
  count: number | undefined,
): void {
  const { [documentId]: _, ...others } = awaiting;
  awaiting = count ? { ...others, [documentId]: count } : others;
}
export function setKeyring(present: boolean, list: KeyringEntry[]): void {
  hasKeyring = present;
  entries = list;
}
export function say(text: string, isGone = false): void {
  message = text;
  gone = isGone;
}
export function setFindError(text: string): void {
  findError = text;
}
export function reveal(key: string | undefined): void {
  revealed = key;
  copied = false;
}
export function showPairing(
  shown: { address: string; path: string; size: number } | undefined,
): void {
  pairing = shown;
  pairingOver = false;
  pairingCopied = false;
}
export function pairingExpired(): void {
  pairingOver = true;
}
export function setAccount(state: AccountState): void {
  account = state;
}
export function setOrg(name: string | undefined): void {
  org = name;
}
export function setAccountList(
  offer: AccountOffer,
  isAccountKeyring: boolean,
  identityText: string,
): void {
  accountList = offer;
  accountKeyring = isAccountKeyring;
  identity = identityText;
}
export function setIdentityStep(step: IdentityStep | undefined): void {
  identityStep = step;
}
export function setNewSigningKeyOffline(value: boolean): void {
  newSigningKeyOffline = value;
}
export function setAccountKeyError(text: string): void {
  accountKeyError = text;
}
export function setBusy(value: boolean): void {
  busy = value;
}
export function setNewLinkError(documentId: string, text: string): void {
  newLinkErrors = { ...newLinkErrors, [documentId]: text };
}

function copyKey() {
  if (!revealed) return;
  onCopy(revealed);
  copied = true;
}
</script>

<div class="home">
  <header class="home-header">
    <h1>{t().homeTitle}</h1>
    {#if newDocumentHref}
      <a class="home-new button-like" href={newDocumentHref}>{t().newDocument}</a>
    {/if}
  </header>

  {#if account.kind !== "unavailable"}
    <AccountBar state={account} {org} {onSignIn} onCancel={onCancelSignIn} {onSignOut} />
  {/if}

  {#if identityStep && account.kind === "signed-in"}
    <div class="home-confirm" role="status">
      {#if identityStep === "confirm"}
        <p>{t().homeLastStep}</p>
        <button class="home-confirm-identity primary" onclick={onConfirmIdentity}>{t().identityConfirm}</button>
      {:else if identityStep === "unconfirmed"}
        <p>{t().identityUnconfirmed}</p>
        <button class="home-retry-identity" onclick={onRetryIdentity}>{t().identityRetry}</button>
      {:else}
        <p>{t().identityRefused}</p>
        <p class="muted">{t().newSigningKeyExplains}</p>
        {#if newSigningKeyOffline}
          <p class="home-new-signing-key-offline">{t().newSigningKeyOffline}</p>
        {/if}
        <button class="home-new-key" disabled={busy} onclick={onNewSigningKey}>{t().newSigningKey}</button>
      {/if}
    </div>
  {/if}

  {#if message}
    <div class="home-message" role="status">
      <p>{message}</p>
      {#if gone}
        <p class="muted">{t().keyringGoneNewKey}</p>
        <div class="home-row">
          <input
            class="home-new-key"
            type="password"
            autocomplete="off"
            aria-label={t().myDocumentsKey}
            bind:this={newKeyInput}
            onkeydown={(event) => event.key === "Enter" && onNewKey(newKeyInput?.value ?? "")}
          />
          <button class="home-use-new-key" disabled={busy} onclick={() => onNewKey(newKeyInput?.value ?? "")}>{t().openList}</button>
        </div>
        <button class="home-recreate" disabled={busy} onclick={onRecreate}>{t().keyringRecreate}</button>
      {/if}
    </div>
  {/if}

  {#if revealed}
    <section class="home-reveal" aria-labelledby="{uid}-reveal">
      <h2 id="{uid}-reveal">{t().keyRevealTitle}</h2>
      <p class="muted">{t().keyRevealNote}</p>
      <div class="home-row">
        <input class="home-key" readonly value={revealed} aria-label={t().myDocumentsKey} />
        <button class="home-copy" onclick={copyKey}>{copied ? t().copied : t().copy}</button>
      </div>
      <button class="home-kept" onclick={() => reveal(undefined)}>{t().keyKept}</button>
    </section>
  {/if}

  {#if pairing}
    <section class="home-pairing" aria-labelledby="{uid}-pairing">
      <h2 id="{uid}-pairing">{t().pairingTitle}</h2>
      {#if pairingOver}
        <p class="home-pairing-expired">{t().pairingExpired}</p>
        <button class="home-pairing-new" disabled={busy} onclick={onAddDevice}>{t().pairingNew}</button>
      {:else}
        <p class="muted">{t().pairingNote}</p>
        <svg
          class="home-pairing-qr"
          role="img"
          aria-label={t().pairingQr}
          viewBox="0 0 {pairing.size} {pairing.size}"
          shape-rendering="crispEdges"
        >
          <rect width={pairing.size} height={pairing.size} fill="var(--qr-light)" />
          <path d={pairing.path} fill="var(--qr-dark)" />
        </svg>
        <div class="home-row">
          <input class="home-pairing-link" readonly value={pairing.address} aria-label={t().pairingLink} />
          <button
            class="home-pairing-copy"
            onclick={() => {
              if (!pairing) return;
              onCopy(pairing.address);
              pairingCopied = true;
            }}>{pairingCopied ? t().copied : t().copy}</button
          >
        </div>
      {/if}
      <button class="home-pairing-done" onclick={onPairingDone}>{t().pairingDone}</button>
    </section>
  {/if}

  <section class="home-documents" aria-labelledby="{uid}-documents">
    <h2 id="{uid}-documents">{t().myDocuments}</h2>
    {#if accountList.kind === "ask" && !accountList.later}
      <div class="home-account-list home-associate">
        <p>{t().associateQuestion(accountList.count, identity)}</p>
        <ul class="home-associate-titles">
          {#each accountList.titles as title}
            <li>{title}</li>
          {/each}
        </ul>
        {#if accountList.count > accountList.titles.length}
          <p class="muted">{t().associateMore(accountList.count - accountList.titles.length)}</p>
        {/if}
        <div class="home-choices">
          <button class="home-attach primary" disabled={busy} onclick={onAttach}>{t().associate}</button>
          <button class="home-later" disabled={busy} onclick={onLater}>{t().associateLater}</button>
        </div>
      </div>
    {:else if accountList.kind === "ask"}
      <div class="home-account-list">
        <button class="home-attach" disabled={busy} onclick={onAttach}>{t().associateAgain(accountList.count)}</button>
      </div>
    {:else if accountList.kind === "other"}
      <div class="home-account-list home-other">
        <p>{t().otherIdentityQuestion(accountList.count, accountList.name, identity)}</p>
        <ul class="home-associate-titles">
          {#each accountList.titles as title}
            <li>{title}</li>
          {/each}
        </ul>
        {#if accountList.count > accountList.titles.length}
          <p class="muted">{t().associateMore(accountList.count - accountList.titles.length)}</p>
        {/if}
        <div class="home-choices">
          <button class="home-associate-other primary" disabled={busy} onclick={onAssociateOther}>{t().associateOther}</button>
          <button class="home-forget-other" disabled={busy} onclick={onForgetOther}>{t().forgetOther}</button>
          <button class="home-other-sign-out" disabled={busy} onclick={onSignOut}>{t().signOut}</button>
        </div>
        <p class="muted">{t().forgetOtherNote}</p>
      </div>
    {:else if accountList.kind === "needs-key"}
      <div class="home-account-list">
        <p>{t().attachNeedsKey}</p>
        <div class="home-row">
          <input
            class="home-account-key"
            type="password"
            autocomplete="off"
            aria-label={t().accountKeyLabel}
            bind:this={accountKeyInput}
            onkeydown={(event) => event.key === "Enter" && onAccountKey(accountKeyInput?.value ?? "")}
          />
          <button class="home-use-account-key" disabled={busy} onclick={() => onAccountKey(accountKeyInput?.value ?? "")}>{t().openList}</button>
        </div>
        {#if accountKeyError}
          <p class="home-error" role="alert">{accountKeyError}</p>
        {/if}
        <p class="muted home-start-over-intro">{t().startOverIntro}</p>
        <button class="home-start-over" disabled={busy} onclick={onStartOver}>{t().startOver}</button>
      </div>
    {/if}
    {#if available && accountList.kind === "none"}
      <p class="home-mode">
        {#if mode === "identity"}
          {signedIn ? t().homeKeptByIdentity(identity) : t().homeKeptByIdentitySignedOut}
        {:else if mode === "key"}
          {t().homeKeptByKey}
        {:else}
          {t().homeKeptNowhere}
        {/if}
      </p>
    {/if}
    {#if available && hasKeyring && !waiting}
      <!-- 18p.3: a list lost is not found again by signing in. -->
      <p class="home-warning" role="note">
        <strong>{t().homeKeyWarningLead}</strong>
        {t().homeKeyWarning}
      </p>
    {/if}
    {#if !available}
      <p class="muted">{t().keyringUnavailable}</p>
    {:else if hasKeyring}
      {#if entries.length === 0}
        <p class="muted">{t().noDocumentsYet}</p>
      {:else}
        <div class="home-tools">
          <label class="home-tool">
            {t().filterList}
            <input class="home-filter" type="search" bind:value={filter} />
          </label>
          <label class="home-tool">
            {t().sortBy}
            <select class="home-sort" bind:value={sort}>
              <option value="recent">{t().sortRecent}</option>
              <option value="title">{t().sortTitle}</option>
            </select>
          </label>
        </div>
        <ul class="home-list">
          {#each shown as entry (entry.documentId)}
            <li class="home-entry" data-document={entry.documentId}>
              <div class="home-entry-main">
                <a
                  class="home-entry-link"
                  href={entry.link}
                  onclick={(event) => {
                    if (!onOpenEntry) return;
                    event.preventDefault();
                    onOpenEntry(entry.link);
                  }}>{entry.title ?? t().untitled}</a
                >
                {#if awaiting[entry.documentId]}
                  <span class="home-entry-awaiting" title={t().awaitingCount(awaiting[entry.documentId] ?? 0)}
                    >{t().awaiting}<span class="count">{awaiting[entry.documentId]}</span></span
                  >
                {/if}
                <span class="muted home-entry-role">{ROLES[entry.role]}</span>
                {#if entry.openedAt !== null}
                  <span class="muted home-entry-opened">{t().openedOn(formatDate(entry.openedAt))}</span>
                {/if}
              </div>
              {#if entry.state === "deleted"}
                <p class="home-entry-state">{t().stateDeleted}</p>
              {:else if entry.state === "renewed"}
                <p class="home-entry-state">{t().stateRenewed}</p>
                <div class="home-row">
                  <input
                    class="home-new-link"
                    aria-label={t().newLink}
                    value={newLinks[entry.documentId] ?? ""}
                    oninput={(event) => (newLinks = { ...newLinks, [entry.documentId]: event.currentTarget.value })}
                  />
                  <button class="home-save-link" onclick={() => onNewLink(entry.documentId, newLinks[entry.documentId] ?? "")}>{t().saveLink}</button>
                </div>
                {#if newLinkErrors[entry.documentId]}
                  <p class="home-error" role="alert">{newLinkErrors[entry.documentId]}</p>
                {/if}
              {/if}
              <button class="home-remove" onclick={() => onRemove(entry.documentId)}>{t().removeFromList}</button>
            </li>
          {/each}
        </ul>
      {/if}
      {#if !waiting}
        <div class="home-key-actions">
          <button class="home-add-device" disabled={busy} onclick={onAddDevice}>{t().addDevice}</button>
          <button class="home-show-key" onclick={onShowKey}>{t().showKey}</button>
          {#if !accountKeyring}
            <button class="home-change-key" disabled={busy} onclick={onChangeKey}>{t().changeKey}</button>
          {/if}
        </div>
      {/if}
    {:else}
      {#if !signedIn}
        <p class="muted">{t().myDocumentsIntro}</p>
        <button class="home-keep" disabled={busy} onclick={onKeep}>{t().keepMyDocuments}</button>
      {/if}
      <h3>{t().findMyDocuments}</h3>
      <p class="muted">{t().findMyDocumentsIntro}</p>
      <div class="home-row">
        <input
          class="home-find"
          type="password"
          autocomplete="off"
          aria-label={t().myDocumentsKey}
          bind:this={keyInput}
          onkeydown={(event) => event.key === "Enter" && onFind(keyInput?.value ?? "")}
        />
        <button class="home-open" disabled={busy} onclick={() => onFind(keyInput?.value ?? "")}>{t().openList}</button>
      </div>
      {#if findError}
        <p class="home-error" role="alert">{findError}</p>
      {/if}
    {/if}
    {#if available}
      <details class="home-modes" open={entries.length === 0}>
        <summary>{t().homeModesTitle}</summary>
        <ul>
          {#each MODES as [name, text]}
            {#if name !== "identity" || account.kind !== "unavailable"}
              <li data-mode={name} class:current={name === mode}>
                {text}
                {#if name === mode}<strong class="home-mode-yours">({t().homeModeYours})</strong>{/if}
              </li>
            {/if}
          {/each}
        </ul>
        <p class="muted">{t().homeModesPrivate}</p>
      </details>
    {/if}
  </section>
</div>

<style>
  /* How documents are kept: one line each, the reader's marked. */
  .home-modes summary {
    cursor: pointer;
  }
  .home-modes ul {
    margin: 0.5rem 0;
    padding-left: 1.2rem;
    display: grid;
    gap: 0.35rem;
  }
  .home-mode-yours {
    margin-left: 0.35rem;
  }
  /* A list lost is lost: said where the list is, set apart. */
  .home-warning {
    margin: 0 0 1rem;
    padding: 0.6rem 0.9rem;
    border-left: 4px solid var(--comment-line);
    border-radius: var(--radius-s);
    background: var(--warn-bg);
  }
  /* Choices: side by side, each on its line when the width lacks. */
  .home-choices {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .home {
    max-width: var(--column);
    margin: 0 auto;
    padding: 1.5rem 1rem 3rem;
    display: grid;
    gap: 1.5rem;
    font-family: var(--font-ui);
    color: var(--ink);
  }
  .home-header {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    align-items: center;
    justify-content: space-between;
  }
  h1 {
    margin: 0;
    font-size: 1.5rem;
  }
  h2 {
    margin: 0 0 0.6rem;
    font-size: 1.15rem;
  }
  h3 {
    margin: 1.2rem 0 0.4rem;
    font-size: 1rem;
  }
  p {
    margin: 0.3rem 0;
  }
  .muted {
    color: var(--muted);
  }
  .button-like {
    display: inline-block;
    padding: 0.45rem 0.9rem;
    border-radius: var(--radius-s);
    background: var(--pencil);
    color: var(--on-pencil);
    text-decoration: none;
  }
  .home-account-list {
    margin-bottom: 1rem;
  }
  .home-confirm {
    margin-bottom: 1rem;
  }
  .home-confirm p {
    margin: 0 0 0.5rem;
  }
  .home-message,
  .home-confirm,
  .home-reveal,
  .home-pairing {
    padding: 0.75rem 1rem;
    border-radius: var(--radius-m);
    background: var(--warn-bg);
  }
  .home-row {
    display: flex;
    gap: 0.5rem;
    margin: 0.4rem 0;
  }
  .home-row input {
    flex: 1;
    min-width: 0;
  }
  .home-pairing-qr {
    display: block;
    width: min(100%, 18rem);
    height: auto;
    margin: 0.6rem 0;
  }
  .home-pairing-link {
    font-family: var(--font-code);
    font-size: 0.8rem;
  }
  .home-key {
    font-family: var(--font-code);
    font-size: 0.8rem;
  }
  .home-key-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .home-tools {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    margin-bottom: 0.6rem;
  }
  .home-tool {
    display: flex;
    gap: 0.4rem;
    align-items: center;
  }
  .home-list {
    list-style: none;
    margin: 0 0 1rem;
    padding: 0;
    display: grid;
    gap: 0.5rem;
  }
  .home-entry {
    padding: 0.6rem 0.75rem;
    border: 1px solid var(--rule);
    border-radius: var(--radius-m);
    background: var(--paper);
    display: grid;
    gap: 0.3rem;
    justify-items: start;
  }
  .home-entry-main {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem 0.8rem;
    align-items: baseline;
  }
  .home-entry-awaiting {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.85rem;
    white-space: nowrap;
  }
  .home-entry-awaiting .count {
    min-width: 1.35rem;
    padding: 0 0.35rem;
    border-radius: 999px;
    background: var(--pencil);
    color: var(--on-pencil);
    font-size: 0.75rem;
    line-height: 1.35rem;
    text-align: center;
  }
  .home-entry-link {
    color: var(--pencil);
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .home-entry-state,
  .home-error {
    color: var(--del);
  }
</style>
