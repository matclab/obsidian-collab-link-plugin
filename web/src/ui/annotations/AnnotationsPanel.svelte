<!-- The annotations (ADR-0016): a card each, open ones, closed
ones or both, as the filter says (ADR-0052 §1); an error from a decision
above them. Shows what
`annotations-panel.ts` gives it; acts through its callbacks, never on the
docs itself. Creating goes through the selection toolbar. -->
<script lang="ts">
import { flushSync, getContext } from "svelte";
import { t } from "../../i18n/index.js";
import Icon from "../Icon.svelte";
import AnnotationCard from "./AnnotationCard.svelte";
import type { AnnotationTexts } from "./annotation-texts.js";
import type { CardModel, ThenText } from "./card-model.js";

import type { Layout } from "./panel-layout.js";
import { SIGNER_KEYS, type SignerKeys } from "./signer-keys.svelte.js";

interface Props {
  role: "read" | "suggest" | "edit";
  texts: AnnotationTexts;
  onSelect: (id: string) => void;
  onAction: (id: string, action: "accept" | "reject" | "resolve") => void;
  onReply: (id: string, text: string) => string | undefined;
  /** « Nothing to add », or put back (ADR-0050 §4). */
  onSetAside: (id: string, aside: boolean) => void;
  onResize: () => void;
  /** The annotated text of a card, at its click (ADR-0052 §4), and
   * whether its place in today's text is marked. */
  onSeeText?: (id: string) => { text: ThenText; located: boolean };
  /** That text hidden: by its button (`back`: the page goes back where it
   * was), or by a redraw of its card. */
  onHideText?: (id: string, back: boolean) => void;
  /** The cards say what awaits my reply (ADR-0050): the review may walk
   * it. Without (tests, a panel alone), a reviewer walks every open one. */
  marked?: boolean;
}
const {
  role,
  texts,
  onSelect,
  onAction,
  onReply,
  onSetAside,
  onResize,
  onSeeText,
  onHideText,
  marked = false,
}: Props = $props();

let cards = $state.raw<CardModel[]>([]);
let active = $state<string | undefined>(undefined);
let error = $state("");
let layout = $state<Layout>("list");
let sheetOpen = $state(false);
let sheetAll = $state(false);
let review = $state(false);
// Which annotations show (ADR-0052 §1): the view's, never written.
let filter = $state<"open" | "closed" | "all">("open");
function listAll(): void {
  sheetAll = !sheetAll;
  flushSync();
}
// Drawn at once, and the margin placed again.
function choose(next: "open" | "closed" | "all"): void {
  filter = next;
  flushSync();
  onResize();
}
// What the review walks through (ADR-0050 §5): an editor chooses, what is
// to decide by default; a reviewer, what awaits its reply.
// biome-ignore lint/style/useConst: assigned in the template.
let walkKind = $state<"decide" | "awaiting">("decide");
// biome-ignore lint/style/useConst: assigned by bind:this in the template.
let list = $state<HTMLElement>();

/** The card whose annotated text is shown, as it was drawn: a redraw (a
 * new model) folds it (ADR-0052 §4). Placed in the margin, by its text,
 * if that is marked. */
let seen = $state.raw<{ card: CardModel; text: ThenText; located: boolean }>();
function seeText(card: CardModel): void {
  const id = card.id;
  if (seen?.card.id === id) {
    seen = undefined;
    onHideText?.(id, true);
  } else {
    if (seen) onHideText?.(seen.card.id, false);
    const shown = onSeeText?.(id);
    seen = shown && { card, ...shown };
  }
  flushSync();
  onResize();
}
const then = (card: CardModel) =>
  seen?.card === card ? { text: seen.text } : undefined;

export function show(next: CardModel[]): void {
  cards = next;
  if (seen && !next.includes(seen.card)) {
    const id = seen.card.id;
    seen = undefined;
    onHideText?.(id, false);
  }
}
/** The annotated text folded, its mark gone (another card chosen). */
export function fold(): void {
  seen = undefined;
}
export function setActive(id: string | undefined): void {
  active = id;
}
export function fail(message: string): void {
  error = message;
}
export function setLayout(next: Layout): void {
  layout = next;
  if (next !== "sheet") sheetOpen = false;
}
/** In the sheet layout: shows it, on the active card. */
export function openSheet(): void {
  sheetOpen = true;
}
/** The review: one card at a time, deciding goes on. */
export function setReview(on: boolean): void {
  review = on;
  sheetAll = false;
  if (on) sheetOpen = true;
}
/** The card the sheet shows, if any. */
export function shown(): CardModel | undefined {
  return shownInSheet;
}
/** Decides on the card shown: `accept` resolves a comment. */
export function act(action: "accept" | "reject"): void {
  const card = shownInSheet;
  if (!card) return;
  const chosen =
    action === "accept" && card.actions.includes("resolve")
      ? "resolve"
      : action;
  if (card.actions.includes(chosen)) decide(card.id, chosen);
}
export function openList(): HTMLElement | undefined {
  return list;
}

export function step(by: number): void {
  const at = walk.findIndex((card) => card.id === active);
  const next = walk[(Math.max(at, 0) + by + walk.length) % walk.length];
  if (next) onSelect(next.id);
}

// In the review, deciding goes on to the next card still to decide.
function decide(id: string, action: "accept" | "reject" | "resolve"): void {
  const before = walk.findIndex((card) => card.id === id);
  onAction(id, action);
  if (!review) return;
  const next = walk[Math.min(Math.max(before, 0), walk.length - 1)];
  if (next) onSelect(next.id);
}

// In the walk of what awaits me, answering or setting aside goes on to
// the next card, as deciding does.
function goOn(id: string): void {
  const at = walk.findIndex((card) => card.id === id);
  const next = walk[at + 1] ?? walk[at - 1];
  if (next) onSelect(next.id);
}
function reply(id: string, text: string): string | undefined {
  const problem = onReply(id, text);
  if (problem === undefined && walking === "awaiting") goOn(id);
  return problem;
}
function setAside(id: string, aside: boolean): void {
  if (aside && walking === "awaiting") goOn(id);
  onSetAside(id, aside);
}

/** A key brought forward (ADR-0051 §4): its cards stand out, the others
 * are dimmed. */
const keys = getContext<SignerKeys | undefined>(SIGNER_KEYS);
const forward = $derived.by(() => {
  const chosen = keys?.chosen;
  return chosen ? new Set(keys?.signed.get(chosen.fingerprint)) : undefined;
});
const standing = (id: string) =>
  forward === undefined ? undefined : forward.has(id) ? "forward" : "dimmed";

// A closed card whose text is marked stands in the margin, by it.
const placed = $derived(
  layout === "margin" && seen?.located && !seen.card.open
    ? seen.card
    : undefined,
);
const open = $derived(cards.filter((card) => card.open));
const closed = $derived(cards.filter((card) => !card.open));
const listed = $derived(closed.filter((card) => card !== placed));
const showsOpen = $derived(filter !== "closed");
// Closed cards in a list, never placed in the margin; in the sheet, with
// every card only.
const showsClosed = $derived(
  filter !== "open" && (layout !== "sheet" || sheetAll),
);
const showsFilter = $derived(
  cards.length > 0 && (layout !== "sheet" || sheetAll),
);
// What the review walks: for an editor, its choice; for a reviewer, what
// awaits its reply; for a reader, every open card. Out of the review,
// every open card.
const walking = $derived(
  !review || role === "read"
    ? "open"
    : role === "edit"
      ? marked
        ? walkKind
        : "decide"
      : marked
        ? "awaiting"
        : "open",
);
const walk = $derived(
  walking === "decide"
    ? open.filter((card) => card.actions.length > 0)
    : walking === "awaiting"
      ? open.filter((card) => card.awaiting === "awaiting")
      : open,
);
// The sheet shows the active card, else the first of its walk.
const shownInSheet = $derived(
  walk.find((card) => card.id === active) ?? walk[0],
);
const position = $derived(shownInSheet ? walk.indexOf(shownInSheet) + 1 : 0);
</script>

<div
  class="annotations-panel layout-{layout}"
  class:all={sheetAll}
  hidden={layout === "sheet" && !sheetOpen}
  role={layout === "sheet" ? "dialog" : undefined}
  aria-label={layout === "sheet" ? t().annotations : undefined}
>
  {#if layout === "sheet"}
    <div class="sheet-head">
      {#if review && role === "edit" && marked}
        <div class="segmented walk-choice" role="group" aria-label={t().walkChoice}>
          <button aria-pressed={walkKind === "decide"} onclick={() => (walkKind = "decide")}>{t().walkDecide}</button>
          <button aria-pressed={walkKind === "awaiting"} onclick={() => (walkKind = "awaiting")}>{t().walkAwaiting}</button>
        </div>
      {/if}
      {#if walk.length > 0 && !sheetAll}
        <button class="icon-button" aria-label={t().previous} onclick={() => step(-1)}><Icon name="left" /></button>
        <span class="sheet-count">{t().countOf(position, walk.length)}</span>
        <button class="icon-button" aria-label={t().next} onclick={() => step(1)}><Icon name="right" /></button>
      {/if}
      <span class="spacer"></span>
      {#if (open.length > 1 || closed.length > 0) && !review}
        <!-- Every card listed, with the filter; or back to one at a time:
        its label says what it does (not « Toutes » twice). -->
        <button class="quiet sheet-all" onclick={listAll}>{sheetAll ? t().oneAtATime : t().allCount(open.length)}</button>
      {/if}
      <button class="icon-button sheet-close" aria-label={t().close} onclick={() => (sheetOpen = false)}>×</button>
    </div>
  {/if}
  {#if showsFilter}
    <div class="segmented annotations-filter" role="group" aria-label={t().annotationsFilter}>
      <button data-filter="open" aria-pressed={filter === "open"} onclick={() => choose("open")}>{t().filterOpen(open.length)}</button>
      <button data-filter="closed" aria-pressed={filter === "closed"} onclick={() => choose("closed")}>{t().filterClosed(closed.length)}</button>
      <button data-filter="all" aria-pressed={filter === "all"} onclick={() => choose("all")}>{t().filterAll(cards.length)}</button>
    </div>
  {/if}
  {#if error}<p class="panel-error" role="alert">{error}</p>{/if}
  {#if filter === "closed" && showsClosed}
    {#if closed.length === 0}<p class="panel-empty">{t().noClosed}</p>{/if}
  {:else if open.length === 0 && (filter === "open" || closed.length === 0 || !showsClosed)}
    <p class="panel-empty">{role === "read" || review ? t().noOpenRead : t().noOpen}</p>
  {:else if review && walk.length === 0}
    <p class="panel-empty review-done" role="status">{walking === "awaiting" ? t().nothingLeftToAnswer : t().nothingLeft}</p>
  {/if}
  <!-- The open cards, which the margin places; empty when hidden. -->
  <div class="annotations-list open-list" bind:this={list}>
    {#if showsOpen || (layout === "sheet" && !sheetAll)}
      {#each open as card (card.id)}
        {#if layout !== "sheet" || sheetAll || card === shownInSheet}
          <AnnotationCard {card} {texts} active={card.id === active} standing={standing(card.id)} {onSelect} onAction={decide} onReply={reply} onSetAside={setAside} {onResize} then={then(card)} onSeeText={onSeeText && seeText} />
        {/if}
      {/each}
    {/if}
    {#if placed}
      <AnnotationCard card={placed} {texts} active={placed.id === active} standing={standing(placed.id)} {onSelect} {onAction} {onReply} onSetAside={setAside} {onResize} then={then(placed)} onSeeText={onSeeText && seeText} />
    {/if}
  </div>
  {#if showsClosed && listed.length > 0}
    <div class="annotations-list closed-list">
      {#each listed as card (card.id)}
        <AnnotationCard {card} {texts} active={card.id === active} standing={standing(card.id)} {onSelect} {onAction} {onReply} onSetAside={setAside} {onResize} then={then(card)} onSeeText={onSeeText && seeText} />
      {/each}
    </div>
  {/if}
</div>

<style>
  .annotations-panel {
    display: grid;
    gap: 0.75rem;
  }
  .annotations-list {
    display: grid;
    gap: 0.6rem;
  }
  .panel-error {
    margin: 0;
    color: var(--del);
  }
  .panel-empty {
    margin: 0;
    color: var(--muted);
    font-size: 0.9rem;
  }
  /* In the margin, cards are placed by margin.ts; only the active one
     unfolds, the others say who and which passage (decision 7), not when. */
  .layout-margin > .open-list {
    position: relative;
    display: block;
  }
  .layout-margin > .open-list > :global(.annotation-item) {
    position: absolute;
    left: 0;
    right: 0;
  }
  .layout-margin > .open-list > :global(.annotation-item:not(.active) :is(.card-when, .card-body, .card-note, .annotation-actions, .card-thread, .card-reply-box)) {
    display: none;
  }
  .layout-margin > .open-list > :global(.annotation-item:not(.active) .reply-count) {
    display: block;
  }
  .layout-margin > .open-list > :global(.annotation-item:not(.active) .card-quote) {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .layout-sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 30;
    max-height: 40vh;
    overflow: auto;
    padding: 0 0.75rem 0.75rem;
    border-top: 1px solid var(--rule);
    border-radius: 14px 14px 0 0;
    background: var(--paper);
    box-shadow: var(--shadow);
  }
  .layout-sheet.all {
    max-height: 70vh;
  }
  /* Wide, with the margin hidden: as wide as the text's column. */
  @container document-view (width > 56.25rem) {
    .layout-sheet {
      left: 50%;
      right: auto;
      width: min(var(--column), calc(100vw - 2rem));
      transform: translateX(-50%);
    }
  }
  .sheet-head {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.5rem 0;
    background: var(--paper);
  }
  .sheet-count {
    color: var(--muted);
    font-size: 0.85rem;
  }
  .spacer {
    flex: 1;
  }
  .sheet-close {
    font-size: 1.4rem;
  }
</style>
