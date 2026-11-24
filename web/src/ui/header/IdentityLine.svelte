<!-- The identity line of the document menu: « Se
connecter », or the identity and whether what is written carries its
name — if not yet, why, and the gesture that makes it appear. Judged by
`identity-line.ts`; acts through `createIdentityLine`. -->
<script lang="ts">
import { t } from "../../i18n/index.js";
import type { IdentityLine } from "./identity-line.js";

interface Props {
  /** The home page, where the list is associated or opened. */
  homeHref: string;
  /** The host's own list, opened instead of the home page. */
  onHome?: () => void;
  /** In the click: the window opens at once (ADR-0041). */
  onSignIn: () => void;
  /** « Confirmer votre identité »: a recent sign-in, in the click. */
  onConfirm: () => void;
  onCancel: () => void;
  /** The gateway out of reach: the list and the attestation again. */
  onRetry: () => void;
  /** « Nouvelle clé de signature » (NK6). */
  onNewKey: () => void;
}
const {
  homeHref,
  onHome,
  onSignIn,
  onConfirm,
  onCancel,
  onRetry,
  onNewKey,
}: Props = $props();

let line = $state<IdentityLine>({ kind: "hidden" });
let org = $state<string | undefined>(undefined);

export function show(next: IdentityLine, orgName: string | undefined): void {
  line = next;
  org = orgName;
}
</script>

{#snippet home(label: string)}
  {#if onHome}
    <button class="identity-home" onclick={onHome}>{label}</button>
  {:else}
    <a class="identity-home" href={homeHref} target="_blank" rel="noopener">{label}</a>
  {/if}
{/snippet}

{#if line.kind !== "hidden"}
  <div class="identity-line">
    <h3>{t().identityOf(org)}</h3>
    {#if line.kind === "sign-in"}
      <button class="identity-sign-in" disabled={!line.ready} onclick={onSignIn}>{t().signIn}</button>
    {:else if line.kind === "pending"}
      <p>{t().signInPending}</p>
      <button class="identity-cancel" onclick={onCancel}>{t().signInCancel}</button>
    {:else}
      <p class="identity-who">{line.who}</p>
      {#if line.kind === "attested"}
        <p class="identity-ok">{t().identityAttested}</p>
      {:else if line.kind === "associate" || line.kind === "open-here"}
        <p class="identity-reason">
          {t().identityNotYet}
          {@render home(line.kind === "associate" ? t().identityAssociate : t().identityOpenHere)}
        </p>
      {:else if line.kind === "confirm"}
        <p class="identity-reason">{t().identityNotYet}</p>
        <button class="identity-confirm" onclick={onConfirm}>{t().identityConfirm}</button>
      {:else if line.kind === "unconfirmed"}
        <p class="identity-reason">{t().identityUnconfirmed}</p>
        <button class="identity-retry" onclick={onRetry}>{t().identityRetry}</button>
      {:else if line.kind === "refused"}
        <p class="identity-reason">{t().identityRefused}</p>
        <p class="identity-new-key-explains">{t().newSigningKeyExplains}</p>
        {#if line.replacing === "offline"}
          <p class="identity-new-key-offline" role="status">{t().newSigningKeyOffline}</p>
        {/if}
        <button class="identity-new-key" disabled={line.replacing === "busy"} aria-busy={line.replacing === "busy"} onclick={onNewKey}>{t().newSigningKey}</button>
      {:else if line.kind === "other"}
        <p class="identity-reason">{t().identityOther}</p>
        <p>{@render home(t().identityChooseHome)}</p>
      {/if}
    {/if}
  </div>
{/if}

<style>
  h3 {
    margin: 0 0 0.4rem;
    font-size: 0.95rem;
  }
  .identity-who {
    margin: 0.25rem 0;
    font-weight: 600;
  }
  .identity-ok,
  .identity-reason,
  .identity-new-key-explains,
  .identity-new-key-offline {
    margin: 0.25rem 0;
  }
  .identity-new-key-explains {
    color: var(--muted);
  }
</style>
