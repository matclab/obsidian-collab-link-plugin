<!-- Export the document as a .md file, for every role; import one into an
empty document, for an editor (phase 6 decision 8). Shows what
`document-files.ts` gives it; acts through its callbacks. -->
<script lang="ts">
import { t } from "../../i18n/index.js";
interface Props {
  onExport: (withAnnotations: boolean) => void;
  /** The journal of the annotations (ADR-0052 §5). */
  onJournal: () => void;
  onImport: (file: File) => void;
}
const { onExport, onJournal, onImport }: Props = $props();

let canImport = $state(false);
let message = $state("");

export function setCanImport(value: boolean): void {
  canImport = value;
}

export function say(text: string): void {
  message = text;
}
</script>

<div class="document-files">
  <h3>{t().files}</h3>
  <div class="files-row">
    <button onclick={() => onExport(true)}>{t().exportMd}</button>
    <button onclick={() => onExport(false)}>{t().exportText}</button>
    <button class="export-journal" onclick={onJournal}>{t().exportJournal}</button>
    {#if canImport}
      <label class="import">
        {t().importMd}
        <input
          type="file"
          accept=".md,.markdown,text/markdown,text/plain"
          onchange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file) onImport(file);
          }}
        />
      </label>
    {/if}
  </div>
  {#if message}
    <p class="files-message" role="status">{message}</p>
  {/if}
</div>

<style>
  h3 {
    margin: 0 0 0.4rem;
    font-size: 0.95rem;
  }
  .files-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
  }
  /* A long label goes to the line, in the dialog's width. */
  .files-row button {
    max-width: 100%;
    white-space: normal;
    text-align: left;
  }
  .import {
    display: inline-flex;
    gap: 0.4rem;
    align-items: center;
    flex-wrap: wrap;
  }
  .files-message {
    margin: 0.5rem 0 0;
    color: var(--muted);
  }
</style>
