<!-- What awaits my reply (ADR-0050 §5): how many, and ‹ › to go from one to
the next in the text's order; a click on the count goes to the first. -->
<script lang="ts">
import { t } from "../../i18n/index.js";
import Icon from "../Icon.svelte";

interface Props {
  onStep: (by: -1 | 0 | 1) => void;
}
const { onStep }: Props = $props();

let count = $state(0);

export function setCount(next: number): void {
  count = next;
}
</script>

<div class="awaiting-nav" role="group" aria-label={t().awaiting}>
  {#if count > 0}
    <button class="icon-button awaiting-previous" aria-label={t().previousAwaiting} onclick={() => onStep(-1)}><Icon name="left" /></button>
    <button class="quiet awaiting-count" title={t().awaitingCount(count)} onclick={() => onStep(0)}>{t().awaiting}<span class="count">{count}</span></button>
    <button class="icon-button awaiting-next" aria-label={t().nextAwaiting} onclick={() => onStep(1)}><Icon name="right" /></button>
  {:else}
    <span class="awaiting-none">{t().nothingAwaiting}</span>
  {/if}
</div>

<style>
  .awaiting-nav {
    display: inline-flex;
    align-items: center;
    gap: 0.15rem;
  }
  .awaiting-count {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    white-space: nowrap;
  }
  .count {
    min-width: 1.35rem;
    padding: 0 0.35rem;
    border-radius: 999px;
    background: var(--pencil);
    color: var(--on-pencil);
    font-size: 0.75rem;
    line-height: 1.35rem;
    text-align: center;
  }
  .awaiting-none {
    color: var(--muted);
    font-size: 0.85rem;
    white-space: nowrap;
  }
</style>
