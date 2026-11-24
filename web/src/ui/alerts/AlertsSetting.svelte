<!-- The notifications of the document menu (ADR-0060 §1, §4): offered to
who can reply, asked for on a click only; once granted or blocked, said so
— the browser's settings change it, not the page. Nothing where the browser
has no notifications. Below, this device even with the page closed, where
the server and the browser offer it. -->
<script lang="ts">
import { t } from "../../i18n/index.js";
import type { DeviceNotificationState } from "../../push/device.js";
import type { DeviceAttempt } from "./alerts-invite.js";
import type { AlertPermission } from "./alerts.js";

interface Props {
  onRequest: () => void;
  onDevice?: (on: boolean) => void;
}
const { onRequest, onDevice }: Props = $props();

let now = $state<AlertPermission>("unsupported");
let device = $state<DeviceNotificationState | "unsupported">("unsupported");
let attempt = $state<DeviceAttempt>("idle");

export function setPermission(next: AlertPermission): void {
  now = next;
}

/** This device, and the outcome of the last gesture on it, apart. */
export function setDevice(
  next: DeviceNotificationState | "unsupported",
  outcome: DeviceAttempt,
): void {
  device = next;
  attempt = outcome;
}
</script>

{#if now !== "unsupported" || device !== "unsupported"}
  <h3>{t().alertsTitle}</h3>
{/if}
{#if now === "default"}
  <button class="alerts-request" onclick={onRequest}>{t().alertsOffer}</button>
  <p class="muted">{t().alertsOfferHelp}</p>
{:else if now === "granted"}
  <p>{t().alertsOn}</p>
{:else if now === "denied"}
  <p class="muted">{t().alertsBlocked}</p>
{/if}
{#if device === "on"}
  <p>{t().pushOn}</p>
  <button
    class="push-stop"
    disabled={attempt === "busy"}
    onclick={() => onDevice?.(false)}>{t().pushStop}</button
  >
{:else if device !== "unsupported"}
  <button
    class="push-offer"
    disabled={attempt === "busy"}
    onclick={() => onDevice?.(true)}>{t().pushOffer}</button
  >
  <p class="muted">{t().pushOfferHelp}</p>
{/if}
{#if device !== "unsupported"}
  <!-- What the last gesture gave, whatever this device is: on, it stays. -->
  {#if attempt === "no-key"}
    <p class="muted" role="status">{t().pushNeedsKey}</p>
  {:else if attempt === "refused"}
    <p class="muted" role="status">{t().pushRefused}</p>
  {/if}
{/if}

<style>
  h3 {
    margin: 0 0 0.4rem;
    font-size: 0.95rem;
  }
  p {
    margin: 0.25rem 0;
  }
  .muted {
    color: var(--muted);
  }
  .push-offer,
  .push-stop {
    margin-top: 0.5rem;
  }
</style>
