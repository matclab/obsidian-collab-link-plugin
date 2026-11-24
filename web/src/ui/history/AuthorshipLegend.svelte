<!-- Who wrote, over the text (ADR-0059 §4): the persons of the text
shown, each with its color; the one of the character pointed at, or at the
caret, brought forward with the date of its insertion — in the preview,
those of the block pointed at. Narrow, those alone, and a button that unfolds the list under it, pushing the text down.
Never over the text. Shows what `authorship-view.ts` gives it. -->
<script lang="ts">
import { t } from "../../i18n/index.js";
import type { LegendPerson } from "./authorship-view.js";

let persons = $state<LegendPerson[]>([]);
let designated = $state<(LegendPerson & { when?: string })[]>([]);
let narrow = $state(false);
let unfolded = $state(false);
const listId = $props.id();

export function show(
  next: LegendPerson[],
  pointed: (LegendPerson & { when?: string })[],
  narrowView: boolean,
): void {
  persons = next;
  designated = pointed;
  narrow = narrowView;
}

const unfold = () => {
  unfolded = !unfolded;
};
const named = (person: LegendPerson) => person.name ?? t().unknownAuthor;
const said = (person: LegendPerson & { when?: string }) =>
  person.when ? t().wroteAt(named(person), person.when) : named(person);
const isDesignated = (person: LegendPerson) =>
  designated.some(({ key }) => key === person.key);
</script>

<div class="legend" role="group" aria-label={t().whoWroteLegend}>
  {#if narrow}
    <div class="line">
      {#each designated as person (person.key)}
        <span class="person designated"><span class="swatch {person.color}"></span>{said(person)}</span>
      {/each}
      <button class="quiet unfold" aria-expanded={unfolded} aria-controls={listId} onclick={unfold}>{t().everyone(persons.length)}</button>
    </div>
    {#if unfolded}
      <ul class="persons" id={listId}>
        {#each persons as person (person.key)}
          <li class="person" class:designated={isDesignated(person)}><span class="swatch {person.color}"></span>{named(person)}</li>
        {/each}
      </ul>
    {/if}
  {:else}
    <div class="line">
      <ul class="persons">
        {#each persons as person (person.key)}
          <li class="person" class:designated={isDesignated(person)}><span class="swatch {person.color}"></span>{named(person)}</li>
        {/each}
      </ul>
      {#if designated.length > 0}
        <span class="said">{designated.map(said).join(", ")}</span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .legend {
    font-size: 0.85em;
    color: var(--ink);
  }
  .line {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-height: 2rem;
  }
  .persons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.75rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .person {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    overflow-wrap: anywhere;
  }
  .person.designated {
    font-weight: 600;
  }
  .swatch {
    flex: none;
    width: 0.8rem;
    height: 0.8rem;
    border-radius: 50%;
    /* The person's tint, as on the text, edged with its line (3:1 on the
       paper, WCAG 1.4.11), both set by its class (page.css). */
    box-sizing: border-box;
    background: var(--author-tint);
    border: 2px solid var(--author-line);
  }
  .person.designated .swatch {
    outline: 2px solid var(--ink);
    outline-offset: 1px;
  }
  .said {
    margin-left: auto;
    color: var(--muted);
    text-align: right;
  }
  .unfold {
    margin-left: auto;
    flex: none;
  }
  ul.persons:not(.line > .persons) {
    padding: 0.25rem 0 0.5rem;
  }
</style>
