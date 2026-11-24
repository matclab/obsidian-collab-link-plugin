<!-- The key brought forward (ADR-0051 §4): its fingerprint's start, how
many annotations it signed, ‹ › from one to the next in the text's order,
× back to the usual view. Nothing while no key is chosen. -->
<script lang="ts">
import { flushSync } from "svelte";
import { t } from "../../i18n/index.js";
import Icon from "../Icon.svelte";
import type { SignerKeys } from "./signer-keys.svelte.js";

interface Props {
  keys: SignerKeys;
  onStep: (by: -1 | 1) => void;
}
const { keys, onStep }: Props = $props();

const count = $derived(
  keys.chosen ? (keys.signed.get(keys.chosen.fingerprint)?.length ?? 0) : 0,
);
</script>

{#if keys.chosen}
  {@const short = keys.chosen.short}
  <div class="key-nav" role="group" aria-label={t().keyBroughtForward(short, count)}>
    <button class="icon-button" aria-label={t().previousOfKey} onclick={() => onStep(-1)}><Icon name="left" /></button>
    <span class="key-chip" aria-hidden="true"><Icon name="key" /><code>{short.slice(0, 4)}</code><span class="count">{count}</span></span>
    <button class="icon-button" aria-label={t().nextOfKey} onclick={() => onStep(1)}><Icon name="right" /></button>
    <button
      class="icon-button key-nav-close"
      aria-label={t().stopBringingForward}
      onclick={() => {
        keys.chosen = undefined;
        flushSync();
      }}>×</button>
  </div>
{/if}

<style>
  .key-nav {
    display: inline-flex;
    align-items: center;
    gap: 0.15rem;
  }
  .key-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0 0.3rem;
    color: var(--ink);
    font-size: 0.85rem;
    white-space: nowrap;
  }
  .key-chip :global(.icon) {
    width: 14px;
    height: 14px;
  }
  .key-chip code {
    font-family: var(--font-code);
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
  .key-nav-close {
    font-size: 1.2rem;
  }
</style>
