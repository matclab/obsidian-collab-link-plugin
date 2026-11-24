<!-- Deleting the document (ADR-0023, ADR-0024), for an editor, last in
the document menu: confirmed by typing a word rather than a click.
Acts through `document-lifecycle.ts`. -->
<script lang="ts">
import { t } from "../../i18n/index.js";

interface Props {
  onDelete: () => void;
}
const { onDelete }: Props = $props();

// biome-ignore lint/style/useConst: assigned by bind:value in the template.
let typed = $state("");
let error = $state<string | undefined>(undefined);
let gone = $state(false);
const confirmed = $derived(
  typed.trim().toLocaleLowerCase() === t().deleteWord.toLocaleLowerCase(),
);

export function fail(message: string) {
  error = message;
}

export function deleted() {
  gone = true;
  error = undefined;
}
</script>

{#if !gone}
  <div class="danger-zone">
    <h3>{t().deleteDocument}</h3>
    <p class="muted">{t().deleteNote}</p>
    <div class="danger-row">
      <input class="delete-confirm" bind:value={typed} placeholder={t().deleteTypeWord(t().deleteWord)} aria-label={t().deleteTypeWord(t().deleteWord)} />
      <button class="delete-document danger" disabled={!confirmed} onclick={onDelete}>{t().deleteDocument}</button>
    </div>
    {#if error}
      <p class="lifecycle-error" role="alert">{error}</p>
    {/if}
  </div>
{/if}

<style>
  .danger-zone {
    padding: 0.75rem;
    border: 1px solid var(--del-bg);
    border-radius: var(--radius-m);
  }
  h3 {
    margin: 0 0 0.4rem;
    font-size: 0.95rem;
    color: var(--del);
  }
  p {
    margin: 0 0 0.5rem;
  }
  .muted {
    color: var(--muted);
  }
  .danger-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .delete-confirm {
    flex: 1;
    min-width: 10rem;
  }
  .lifecycle-error {
    color: var(--del);
    margin: 0.5rem 0 0;
  }
</style>
