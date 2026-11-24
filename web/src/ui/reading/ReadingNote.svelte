<!-- Over the text, in Reading: that it is read only and how
many suggestions are pending: it shows the current text only. Shows what
`view-switch.ts` gives it. -->
<script lang="ts">
import { t } from "../../i18n/index.js";

interface Props {
  /** Whether it says « Read only »: not where nothing is written. */
  readOnlyNote: boolean;
}
const { readOnlyNote }: Props = $props();

let shown = $state(false);
let pending = $state(0);

export function setShown(next: boolean): void {
  shown = next;
}

export function setPending(count: number): void {
  pending = count;
}
</script>

{#if shown && (readOnlyNote || pending > 0)}
  <!-- Reading looks like the formatted editor: it says so. -->
  <span class="reading-note">
    {#if readOnlyNote}
      <span class="read-only-note">{t().readOnly}</span>
    {/if}
    {#if readOnlyNote && pending > 0}·{/if}
    {#if pending > 0}
      <span class="pending-suggestions">{t().pendingInPreview(pending)}</span>
    {/if}
  </span>
{/if}

<style>
  /* Under the other tools over the text, across. */
  .reading-note {
    order: 10;
    flex-basis: 100%;
    text-align: right;
    color: var(--muted);
    font-size: 0.85em;
  }
</style>
