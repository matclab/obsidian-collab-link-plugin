<!-- The mark of a signed name (phase 18, decision 11; ADR-0051;
docs/protocol/06-identity.md, ID-17, ID-18, ID-39, ID-42): an icon after
the name, a key, or « verified » for an attested one, the name shown being
the attested one; a word when there is something to say; a click (or
Enter) shows the key and what it means — never on hover alone, which touch
and keyboards don't have. Nothing for an unverified object: its name shows
as it always did. -->
<script lang="ts">
import { flushSync, getContext } from "svelte";
import type { Verdict } from "../../../lib/src/index.js";
import { formatDate, t } from "../../i18n/index.js";
import {
  OWN_SIGNATURE,
  type OwnSignature,
} from "../../view-model/own-signature.svelte.js";
import Icon from "../Icon.svelte";
import { SIGNER_KEYS, type SignerKeys } from "./signer-keys.svelte.js";

interface Props {
  verdict: Verdict;
  /** The name it marks, for the label. */
  name: string;
  /** Opened or closed: its height changed (the margin places the cards
   * again). */
  onToggle?: () => void;
}
const { verdict, name, onToggle }: Props = $props();
// Unique in the window.
const uid = $props.id();
// biome-ignore lint/style/useConst: assigned in the template.
let open = $state(false);
/** This browser's key and why it doesn't carry the name. */
const own = getContext<OwnSignature | undefined>(OWN_SIGNATURE);
/** Mine, and what each key signed: in a panel only. */
const keys = getContext<SignerKeys | undefined>(SIGNER_KEYS);

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

// The first that applies (ADR-0051 §2); an attested name is the
// attestation's, never the one it carries under two keys.
const alert = $derived(
  !verdict.signed
    ? undefined
    : verdict.revokedAt !== undefined
      ? t().alertRevoked
      : !verdict.attested && verdict.twoKeys
        ? t().alertKeys(verdict.nameKeys?.length ?? 2)
        : verdict.late
          ? t().alertLate
          : undefined,
);
// The keys of its name, this one first (ADR-0051 §3).
const nameKeys = $derived.by(() => {
  if (!verdict.signed || !verdict.nameKeys) return [];
  const self = toHex(verdict.fingerprint);
  return [...verdict.nameKeys]
    .sort(
      (x, y) => Number(y.fingerprint === self) - Number(x.fingerprint === self),
    )
    .map((key) => ({ ...key, self: key.fingerprint === self }));
});
</script>

{#if verdict.signed}
  {@const attested = verdict.attested}
  {@const label = attested ? t().attestedNameLabel(attested.name, attested.issuer) : t().signedNameLabel(name, verdict.short)}
  <span
    class="signature"
    class:attested={attested !== undefined}
    class:warn={alert !== undefined}
  >
    <button
      class="signature-mark"
      aria-expanded={open}
      aria-controls="{uid}-details"
      aria-label={alert ? t().withAlert(label, alert) : label}
      onclick={() => {
        open = !open;
        flushSync();
        onToggle?.();
      }}
    >
      <Icon name={attested ? "verified" : "key"} />
      {#if alert}<span class="signature-alert-word">{alert}</span>{/if}
    </button>
    {#if open}
      <span class="signature-details" id="{uid}-details" role="note" aria-label={t().signatureDetails}>
        {#if attested}
          <span class="signature-line">{t().attestedAs(attested.name)}</span>
          {#if attested.email}<span class="signature-line">{t().attestedEmail(attested.email)}</span>{/if}
          <span class="signature-line">{t().attestedBy(attested.issuer)}</span>
          <span class="signature-line">{t().attestedValid(formatDate(attested.issuedAt * 1000), formatDate(attested.expiresAt * 1000))}</span>
          <span class="signature-line">{t().signedWith(verdict.short)}</span>
          <span class="signature-line muted">{t().attestedExplains}</span>
        {:else}
          <span class="signature-line">{t().signedWith(verdict.short)}</span>
          <!-- With two keys, what they mean says it (ADR-0051 §3). -->
          {#if !verdict.twoKeys}<span class="signature-line muted">{t().signatureExplains}</span>{/if}
          {#if own?.reason && own.short === verdict.short}
            <span class="signature-line signature-own">{own.reason} {t().identityInMenu}</span>
          {/if}
          {#if verdict.twoKeys}
            <span class="signature-line signature-alert">{t().nameKeysTitle(name, nameKeys.length || 2)}</span>
            <span class="signature-line muted">{t().nameKeysExplains}</span>
            {#if nameKeys.length > 0}
              <ul class="signature-keys">
                {#each nameKeys as key (key.fingerprint)}
                  <li class="signature-key">
                    <code>{key.short}</code>
                    <span class="key-about">
                      {#if key.self}<span class="key-tag">{t().thisKey}</span>{/if}
                      {#if keys?.mine.has(key.fingerprint)}<span class="key-tag">{t().yourKey}</span>{/if}
                      {#if keys}
                        <span class="muted">{t().keySignedIn(keys.signed.get(key.fingerprint)?.length ?? 0)}</span>
                        <!-- What it signed, brought forward (ADR-0051 §4). -->
                        <button
                          class="quiet key-highlight"
                          aria-pressed={keys.chosen?.fingerprint === key.fingerprint}
                          aria-label={t().highlightKey(key.short)}
                          onclick={(event) => {
                            event.stopPropagation();
                            if (!keys) return;
                            keys.chosen = keys.chosen?.fingerprint === key.fingerprint ? undefined : { fingerprint: key.fingerprint, short: key.short };
                            flushSync();
                          }}
                        >{t().highlight}</button>
                      {/if}
                    </span>
                  </li>
                {/each}
              </ul>
            {/if}
          {/if}
        {/if}
        {#if verdict.revokedAt !== undefined}
          <span class="signature-line signature-alert">{t().keyRevoked(formatDate(verdict.revokedAt * 1000))}</span>
          <span class="signature-line muted">{t().keyRevokedExplains}</span>
        {/if}
        {#if verdict.late}
          <span class="signature-line signature-alert">{t().signatureLate(formatDate(verdict.late.dated), formatDate(verdict.late.received))}</span>
          <span class="signature-line muted">{t().signatureLateExplains}</span>
        {/if}
      </span>
    {/if}
  </span>
{/if}

<style>
  /* Its mark and its details are items of the line that holds it: the
     details below the line, the mark on it. */
  .signature {
    display: contents;
  }
  .signature-mark {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    justify-content: center;
    padding: 0 0.2rem;
    border: 1px solid transparent;
    border-radius: var(--radius-s);
    background: transparent;
    color: var(--muted);
    font-size: 0.75rem;
    line-height: 1.4;
    min-width: 24px;
    min-height: 24px;
    vertical-align: middle;
  }
  .signature-mark:hover {
    background: var(--paper-2);
  }
  .signature-mark :global(.icon) {
    width: 14px;
    height: 14px;
  }
  .attested .signature-mark {
    color: var(--ins);
  }
  .warn .signature-mark {
    padding: 0 0.3rem;
    border-color: var(--del);
    color: var(--del);
  }
  .signature-alert-word {
    font-weight: 600;
  }
  .signature-details {
    display: grid;
    gap: 0.2rem;
    flex-basis: 100%;
    margin: 0.2rem 0;
    padding: 0.4rem 0.5rem;
    border-radius: var(--radius-s);
    background: var(--paper-2);
    color: var(--ink);
    font-size: 0.8rem;
    font-weight: 400;
  }
  .muted {
    color: var(--muted);
  }
  .signature-alert {
    color: var(--del);
  }
  /* A key, then what is said of it, beside or under. */
  .signature-keys {
    display: grid;
    gap: 0.2rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  /* Fingerprints have one length: their columns align. */
  .signature-key {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.5rem;
    align-items: baseline;
  }
  .key-about {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.3rem;
  }
  .signature-key code {
    font-family: var(--font-code);
  }
  .key-highlight {
    min-height: 24px;
    padding: 0 0.35rem;
    font-size: 0.75rem;
  }
  .key-tag {
    padding: 0 0.3rem;
    border-radius: var(--radius-s);
    background: var(--paper);
    font-size: 0.75rem;
  }
</style>
