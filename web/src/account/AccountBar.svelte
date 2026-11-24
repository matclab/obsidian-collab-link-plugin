<!-- The identity on the home: « S'identifier », the sign-in
in progress and « Annuler », or who is signed in and « Se déconnecter ».
Shows what `home.ts` gives it; acts through its callbacks. -->
<script lang="ts">
import { t } from "../i18n/index.js";
import type { AccountState } from "./sign-in.js";

interface Props {
  state: AccountState;
  /** The organisation's name. */
  org?: string | undefined;
  onSignIn: () => void;
  onCancel: () => void;
  onSignOut: () => void;
}
const { state, org, onSignIn, onCancel, onSignOut }: Props = $props();

const reasons = {
  denied: () => t().signInDenied,
  failed: () => t().signInFailed,
  expired: () => t().signInExpired,
};
</script>

<section class="home-account" aria-label={t().identityOf(org)}>
  {#if state.kind === "signed-out"}
    <button class="home-sign-in" disabled={!state.ready} onclick={onSignIn}>{t().signIn}</button>
    {#if state.reason}
      <p class="home-account-said" role="status">{reasons[state.reason]()}</p>
    {/if}
  {:else if state.kind === "pending"}
    <p class="home-account-pending" role="status">{t().signInPending}</p>
    <button class="home-sign-in-cancel" onclick={onCancel}>{t().signInCancel}</button>
    <p class="muted">{t().signInWindowNote}</p>
  {:else if state.kind === "signed-in"}
    <p class="home-signed-in">
      {t().identityLabel(org, t().identityWho(state.name, state.email))}
    </p>
    <button class="home-sign-out" onclick={onSignOut}>{t().signOut}</button>
  {/if}
</section>

<style>
  .home-account {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1rem;
    align-items: center;
  }
  .home-account p {
    margin: 0;
  }
  .home-signed-in {
    overflow-wrap: anywhere;
  }
  .home-account-said {
    color: var(--del);
  }
  .muted {
    flex-basis: 100%;
    color: var(--muted);
  }
</style>
