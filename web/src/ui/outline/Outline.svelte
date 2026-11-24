<!-- The document's outline: its headings,
nested by level, the one read marked. Its branches folded one by one or by
depth (ADR-0062, PV4 to PV8), for this opening only. Shows what
`outline-column.ts` gives it; acts through its callbacks. -->
<script lang="ts" module>
import type { TreeItem } from "../../outline/outline-tree.js";

export type OutlineItem = TreeItem;
</script>

<script lang="ts">
import { flushSync } from "svelte";
import { t } from "../../i18n/index.js";
import {
  type TreeNode,
  collapseToDepth,
  nest,
  setDepthCollapsed,
  shownCurrent,
  treeDepth,
} from "../../outline/outline-tree.js";
import Icon from "../Icon.svelte";

interface Props {
  onGo: (index: number) => void;
  onClose: () => void;
  onEscape: () => void;
}
const { onGo, onClose, onEscape }: Props = $props();
const id = $props.id();

let items = $state<OutlineItem[]>([]);
let current = $state<number | undefined>(undefined);
/** The keys of the headings folded (PV6): never kept (PV8). */
let collapsed = $state<ReadonlySet<string>>(new Set());
const tree = $derived(nest(items));
const depth = $derived(treeDepth(tree));
const marked = $derived(shownCurrent(tree, collapsed, current));
// biome-ignore lint/style/useConst: assigned by bind:this in the template.
let nav = $state<HTMLElement>();

export function setItems(next: OutlineItem[]): void {
  items = next;
}

export function setCurrent(next: number | undefined): void {
  current = next;
}

/** Brings the marked heading into the view of `scroller`, the list's
 * column or drawer, scrolling nothing else (`scrollIntoView` would move
 * the page too). */
export function showCurrent(scroller: HTMLElement): void {
  const marked = nav?.querySelector<HTMLElement>('[aria-current="location"]');
  if (!marked) return;
  const box = scroller.getBoundingClientRect();
  const item = marked.getBoundingClientRect();
  if (item.top < box.top) scroller.scrollTop -= box.top - item.top;
  else if (item.bottom > box.bottom)
    scroller.scrollTop += Math.min(
      item.bottom - box.bottom,
      item.top - box.top,
    );
}

export function focusFirst(): void {
  (nav?.querySelector<HTMLElement>(".outline-item") ?? nav)?.focus();
}

/** Folds as `next`, rendered at once (ADR-0031). */
function setCollapsed(next: ReadonlySet<string>): void {
  collapsed = next;
  flushSync();
}

function setFolded(node: TreeNode, fold: boolean): void {
  const next = new Set(collapsed);
  if (fold) next.add(node.item.key);
  else next.delete(node.item.key);
  setCollapsed(next);
}

/** A chevron clicked; with Alt, every heading of its depth (PV4). */
function fold(node: TreeNode, event: MouseEvent): void {
  const fold = !collapsed.has(node.item.key);
  if (event.altKey)
    setCollapsed(setDepthCollapsed(tree, collapsed, node.depth, fold));
  else setFolded(node, fold);
}

function keydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    onEscape();
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const buttons = Array.from(
    nav?.querySelectorAll<HTMLElement>(".outline-item") ?? [],
  );
  const at = buttons.indexOf(event.target as HTMLElement);
  if (at < 0) return;
  const next = buttons[at + (event.key === "ArrowDown" ? 1 : -1)];
  if (!next) return;
  event.preventDefault();
  next.focus();
}

/** Right unfolds, then goes to the first child; left folds, then goes
 * to the parent (PV4), as in a tree. */
function itemKeydown(event: KeyboardEvent, node: TreeNode): void {
  const right = event.key === "ArrowRight";
  if (!right && event.key !== "ArrowLeft") {
    keydown(event);
    return;
  }
  event.preventDefault();
  const li = (event.currentTarget as HTMLElement).closest("li");
  const folded = collapsed.has(node.item.key);
  const branch = node.children.length > 0;
  if (right) {
    if (branch && folded) setFolded(node, false);
    else
      li
        ?.querySelector<HTMLElement>(":scope > ul > li > .outline-row > .outline-item")
        ?.focus();
  } else if (branch && !folded) setFolded(node, true);
  else
    li?.parentElement
      ?.closest("li")
      ?.querySelector<HTMLElement>(":scope > .outline-row > .outline-item")
      ?.focus();
}
</script>

{#snippet list(nodes: TreeNode[])}
  <ul>
    {#each nodes as node (node.item.key)}
      {@const folded = collapsed.has(node.item.key)}
      <li>
        <div class="outline-row">
          {#if node.children.length > 0}
            <button
              class="quiet outline-fold"
              tabindex="-1"
              aria-expanded={!folded}
              aria-label={folded
                ? t().expandHeading(node.item.text, node.descendants)
                : t().collapseHeading(node.item.text)}
              title={t().foldHint}
              onclick={(event) => fold(node, event)}><Icon name="right" /></button>
          {:else}
            <span class="outline-fold-space"></span>
          {/if}
          <button
            class="outline-item"
            data-depth={node.depth}
            aria-current={marked === node.item.index ? "location" : undefined}
            onclick={() => onGo(node.item.index)}
            onkeydown={(event) => itemKeydown(event, node)}>{node.item.text}</button>
          {#if folded}
            <span class="outline-count" aria-hidden="true">{node.descendants}</span>
          {/if}
        </div>
        {#if node.children.length > 0 && !folded}
          {@render list(node.children)}
        {/if}
      </li>
    {/each}
  </ul>
{/snippet}

<nav class="outline" class:outline-tiered={depth >= 2} aria-labelledby="{id}-title" tabindex="-1" bind:this={nav}>
  <div class="outline-head">
    <h2 class="outline-title" id="{id}-title">{t().outline}</h2>
    <button class="quiet outline-close" aria-label={t().hideOutline} title={t().hideOutline} onclick={onClose} onkeydown={keydown}><Icon name="left" /></button>
  </div>
  {#if depth >= 2}
    <div class="outline-levels" role="group" aria-labelledby="{id}-levels">
      <span id="{id}-levels">{t().outlineLevels}</span>
      {#each { length: depth }, k}
        <button
          class="quiet"
          aria-label={t().showLevels(k + 1)}
          title={t().showLevels(k + 1)}
          onclick={() => setCollapsed(collapseToDepth(tree, k + 1))}>{k + 1}</button>
      {/each}
    </div>
  {/if}
  {#if items.length === 0}
    <p class="outline-empty">{t().noHeadings}</p>
  {:else}
    {@render list(tree)}
  {/if}
</nav>

<style>
  .outline {
    font-family: var(--font-ui);
    font-size: 0.9em;
  }
  .outline:focus {
    outline: none;
  }
  .outline-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 2.25rem;
  }
  .outline-title {
    margin: 0;
    font-size: 0.85em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
  }
  .outline-levels {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.15rem;
    margin-bottom: 0.4rem;
    color: var(--muted);
    font-size: 0.9em;
  }
  .outline-levels span {
    margin-right: 0.3rem;
  }
  .outline-levels button {
    min-width: 1.75rem;
    padding: 0.15rem 0.4rem;
    justify-content: center;
  }
  .outline-empty {
    color: var(--muted);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  /* A guide along each list of subheadings, under its parent's chevron
     (PV10). */
  ul ul {
    margin-left: 0.625rem;
    padding-left: 0.2rem;
    border-left: 1px solid var(--rule);
  }
  .outline-row {
    display: flex;
    align-items: flex-start;
  }
  .outline-fold,
  .outline-fold-space {
    flex: none;
    width: 1.25rem;
  }
  /* On the heading's first line, however many it wraps on. */
  .outline-fold {
    height: calc(1.35em + 0.5rem);
    justify-content: center;
    padding: 0;
    border: none;
    color: var(--muted);
  }
  .outline-fold :global(.icon) {
    width: 0.85rem;
    height: 0.85rem;
    transition: transform 0.1s;
  }
  .outline-fold[aria-expanded="true"] :global(.icon) {
    transform: rotate(90deg);
  }
  .outline-item {
    display: block;
    flex: 1;
    min-width: 0;
    padding: 0.25rem 0.5rem 0.25rem 0.25rem;
    border: none;
    border-left: 2px solid transparent;
    border-radius: 0;
    background: none;
    color: var(--ink);
    font: inherit;
    text-align: left;
    line-height: 1.35;
    /* A long heading wraps (ADR-0062 §1): the page's buttons don't. */
    white-space: normal;
    overflow-wrap: anywhere;
    cursor: pointer;
  }
  .outline-item:hover {
    background: var(--paper-2);
  }
  /* The hierarchy by depth in the tree (PV9), once there are two: a
     space before each part, its weight, then a lighter tint. */
  .outline-tiered > ul > li + li {
    margin-top: 0.4rem;
  }
  .outline-tiered .outline-item[data-depth="1"] {
    font-weight: 600;
  }
  .outline-tiered .outline-item[data-depth="2"] {
    font-weight: 500;
  }
  .outline-tiered .outline-item[data-depth="4"],
  .outline-tiered .outline-item[data-depth="5"],
  .outline-tiered .outline-item[data-depth="6"] {
    color: var(--muted);
  }
  /* The heading read wins over its depth's tint. */
  .outline .outline-item[aria-current="location"] {
    border-left-color: var(--pencil);
    color: var(--pencil);
    font-weight: 600;
  }
  .outline-count {
    flex: none;
    padding: 0.25rem 0.4rem 0 0;
    color: var(--muted);
    font-size: 0.85em;
    line-height: 1.35;
  }
</style>
