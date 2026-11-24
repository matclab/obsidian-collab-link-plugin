<!-- The writing help (ADR-0046 §6): what one types and what
one gets, rendered by the preview itself; the shortcuts; what is good to
know. Shows what `writing-help.ts` gives it. -->
<script lang="ts">
import { constructName } from "../../editor/construct-name.js";
import { t } from "../../i18n/index.js";
import { HELP_ENTRIES, renderExample } from "./writing-help.js";

interface Props {
  shortcuts: { keys: string; what: string }[];
}
const { shortcuts }: Props = $props();
</script>

<div class="writing-help">
  <h3 class="help-part">{t().helpWriting}</h3>
  <table class="help-examples">
    <colgroup><col class="help-name" /><col /><col /></colgroup>
    <thead>
      <tr><th scope="col"></th><th scope="col">{t().helpYouType}</th><th scope="col">{t().helpYouGet}</th></tr>
    </thead>
    <tbody>
      {#each HELP_ENTRIES as entry (entry.id)}
        <tr data-construct={entry.id}>
          <th scope="row">{constructName(entry.id)}</th>
          <td><pre><code>{entry.example()}</code></pre></td>
          <td class="help-rendered">
            {#if entry.loaded}
              <span class="help-drawn">{t().helpDrawn}</span>
            {:else}
              <!-- The preview's own rendering of the dictionary's example,
              markdown-it without HTML (ADR-0021), in the preview's styles. -->
              <div class="preview help-preview">{@html renderExample(entry.example())}</div>
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>

  <h3 class="help-part">{t().helpShortcuts}</h3>
  <dl class="help-shortcuts">
    {#each shortcuts as shortcut (shortcut.keys)}
      <dt><kbd>{shortcut.keys}</kbd></dt>
      <dd>{shortcut.what}</dd>
    {/each}
  </dl>

  <h3 class="help-part">{t().helpGoodToKnow}</h3>
  <ul class="help-notes">
    <li>{t().helpSlash}</li>
    <li>{t().helpAnchor}</li>
    <li>{t().helpMarkup}</li>
    <li>{t().helpSource}</li>
    <li>{t().helpAnnotationText}</li>
    <li>{t().helpAwaiting}</li>
    <li>{t().helpSuggestAtCaret}</li>
  </ul>
</div>

<style>
  .help-part {
    margin: 1rem 0 0.5rem;
    font-size: 1em;
  }
  /* What one types and what one gets at equal widths, the
     name narrower: a rendering in a sliver broke its words. */
  .help-examples {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
  }
  .help-name {
    width: 9rem;
  }
  .help-examples th,
  .help-examples td {
    padding: 0.25rem 0.5rem;
    border-bottom: 1px solid var(--rule);
    text-align: left;
    vertical-align: top;
  }
  .help-examples thead th {
    color: var(--muted);
    font-weight: 600;
  }
  .help-examples pre {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 0.875rem;
  }
  /* The preview's look, without its room around the text. */
  .help-preview {
    padding: 0;
  }
  .help-preview :global(h1) {
    font-size: 1.5em;
  }
  .help-preview :global(p),
  .help-preview :global(ul),
  .help-preview :global(ol),
  .help-preview :global(h1),
  .help-preview :global(h2),
  .help-preview :global(h3) {
    margin: 0;
  }
  .help-drawn {
    color: var(--muted);
    font-style: italic;
  }
  .help-shortcuts {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 1rem;
    margin: 0;
  }
  .help-shortcuts dd {
    margin: 0;
  }
  /* On a narrow view, each construction on its own lines: its name,
     what one types, what one gets. */
  @container document-view (max-width: 56.25rem) {
    .help-examples {
      table-layout: auto;
    }
    .help-examples thead,
    .help-examples colgroup {
      display: none;
    }
    .help-examples tr,
    .help-examples th,
    .help-examples td {
      display: block;
    }
    .help-examples th,
    .help-examples td {
      border-bottom: 0;
    }
    .help-examples tr {
      padding: 0.25rem 0;
      border-bottom: 1px solid var(--rule);
    }
  }
  .help-notes {
    margin: 0;
    padding-inline-start: 1.25rem;
  }
</style>
