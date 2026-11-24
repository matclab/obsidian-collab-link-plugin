<!-- The invitation to be notified (NI2, NI4, NI5): held at the
bottom of the view, once I published; offers what is left to turn on, each button the
gesture that asks the browser; says how to go back, the menu named by the
icon its button shows. Announced, never taking the focus. -->
<script lang="ts">
import { t } from "../../i18n/index.js";
import Icon from "../Icon.svelte";
import type { InviteOffer } from "./alerts-invite.js";

interface Props {
  onBrowser: () => void;
  onDevice: () => void;
  onLater: () => void;
}
const { onBrowser, onDevice, onLater }: Props = $props();

let offer = $state<InviteOffer | undefined>(undefined);

export function setOffer(next: InviteOffer | undefined): void {
  offer = next;
}
</script>

<div class="alerts-invite-region" role="status">
  {#if offer}
    <div class="notice alerts-invite">
      <div class="notice-text">
        <p class="alerts-invite-question">{t().inviteQuestion}</p>
        <div class="alerts-invite-actions">
          {#if offer.device}
            <button class="invite-device" onclick={onDevice}>{t().pushOffer}</button>
          {/if}
          {#if offer.browser}
            <button class="invite-browser quiet" onclick={onBrowser}
              >{t().alertsOffer}</button
            >
          {/if}
          <button class="invite-later quiet" onclick={onLater}>{t().inviteLater}</button>
        </div>
        <p class="muted">
          {#if offer.device}
            {t().inviteUndoDeviceBefore}
            <span class="alerts-invite-menu"><Icon name="more" /></span><span
              class="alerts-invite-hidden">{t().document}</span
            >
            {t().inviteUndoDeviceAfter}
          {:else}
            {t().inviteUndoBrowser}
          {/if}
        </p>
      </div>
      <button
        class="notice-dismiss icon-button"
        aria-label={t().dismiss}
        onclick={onLater}>×</button
      >
    </div>
  {/if}
</div>

<style>
  .alerts-invite {
    align-items: flex-start;
    border-left-color: var(--pencil);
    background: var(--pencil-bg);
    box-shadow: var(--shadow);
  }
  p {
    margin: 0;
  }
  .alerts-invite-question {
    font-weight: 600;
  }
  .alerts-invite-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0.5rem 0;
  }
  .muted {
    color: var(--muted);
  }
  .alerts-invite-menu {
    display: inline-flex;
    vertical-align: middle;
    padding: 0 0.15rem;
    border: 1px solid var(--rule);
    border-radius: var(--radius-s);
  }
  /* Narrow: over less of the text. */
  @container document-view (max-width: 56.25rem) {
    .alerts-invite-actions {
      gap: 0.25rem;
      margin: 0.35rem 0;
    }
    .muted {
      font-size: 0.8rem;
    }
  }
  /* Read by a screen reader in place of the icon. */
  .alerts-invite-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
