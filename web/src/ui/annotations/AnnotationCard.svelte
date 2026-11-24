<!-- One annotation: who, what they propose or say, about which
passage, where it stands, and what this link may do with it. -->
<script lang="ts">
import { flushSync } from "svelte";
import { t } from "../../i18n/index.js";
import Icon from "../Icon.svelte";
import SignatureMark from "./SignatureMark.svelte";
import type { AnnotationTexts } from "./annotation-texts.js";
import type { CardModel, ThenText } from "./card-model.js";

interface Props {
  card: CardModel;
  /** Its texts as HTML: Markdown, a subset with no link inside the
   * document and nothing that runs (ADR-0047). */
  texts: AnnotationTexts;
  active: boolean;
  /** A key brought forward (ADR-0051 §4): signed by it, or not. */
  standing?: "forward" | "dimmed" | undefined;
  onSelect: (id: string) => void;
  onAction: (id: string, action: "accept" | "reject" | "resolve") => void;
  /** Sends a reply (ADR-0035): an error to show, or nothing once sent. */
  onReply: (id: string, text: string) => string | undefined;
  /** « Nothing to add », or put back (ADR-0050 §4). */
  onSetAside: (id: string, aside: boolean) => void;
  /** The card's height changed on its own (its field): placed again. */
  onResize: () => void;
  /** The text it covers or covered, worked out at the click (ADR-0052
   * §4), while it is shown: the panel holds it, the card may move from
   * its list to the margin meanwhile. */
  then?: { text: ThenText } | undefined;
  /** Shows or hides that text. */
  onSeeText?: (card: CardModel) => void;
}
const {
  card,
  texts,
  active,
  standing,
  onSelect,
  onAction,
  onReply,
  onSetAside,
  onResize,
  then: shown,
  onSeeText,
}: Props = $props();

let replying = $state(false);
let text = $state("");
let error = $state("");
// biome-ignore lint/style/useConst: assigned by bind:this in the template.
let field = $state<HTMLTextAreaElement>();
// biome-ignore lint/style/useConst: assigned by bind:this in the template.
let box = $state<HTMLElement>();

// Drawn at once, as the rest of the panel (ADR-0016).
function openReply(): void {
  replying = true;
  error = "";
  flushSync();
  onResize();
  field?.focus();
  // Its buttons too, at the foot of a sheet that scrolls (jsdom has none).
  box?.scrollIntoView?.({ block: "nearest" });
}
function closeReply(): void {
  replying = false;
  text = "";
  error = "";
  flushSync();
  onResize();
}
function send(): void {
  const problem = onReply(card.id, text);
  if (problem === undefined) closeReply();
  else {
    error = problem;
    flushSync();
    onResize();
  }
}
// As the selection toolbar's comment field: Ctrl/Cmd+Enter sends, Enter
// goes to the line, Escape closes.
function keys(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeReply();
  } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    send();
  }
}

const LABEL = {
  accept: t().acceptAction,
  reject: t().rejectAction,
  resolve: t().resolveAction,
};
const ICON = { accept: "check", reject: "delete", resolve: "check" } as const;
</script>

<!-- A click anywhere on the card selects it; by keyboard, its head. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<article
  class="annotation-item card type-{card.type}"
  class:active
  class:closed={!card.open}
  class:brought-forward={standing === "forward"}
  class:dimmed={standing === "dimmed"}
  data-id={card.id}
  data-state={card.state}
  data-conflicts={card.conflicts.join(" ")}
  onclick={() => onSelect(card.id)}
>
  <!-- The mark after the head, on its line (ADR-0051 §1): not in its
  button. -->
  <div class="card-head-line">
    <button class="card-head" aria-pressed={active} onclick={(event) => { event.stopPropagation(); onSelect(card.id); }}>
      <strong>{card.author}</strong>
      <span class="verb">{card.verb}</span>
      {#if card.awaiting === "awaiting"}<span class="awaiting-mark" role="img" aria-label={t().awaiting} title={t().awaiting}></span>{/if}
    </button>
    <SignatureMark verdict={card.signature} name={card.author} onToggle={onResize} />
    <span class="card-when">{card.when}</span>
  </div>
  {#if card.excerpt !== undefined || card.proposal}
    <blockquote class="card-quote">
      {#if card.type === "comment"}
        {card.excerpt}
      {:else if card.type === "deletion"}
        <del>{card.excerpt}</del>
      {:else if card.type === "substitution"}
        <del>{card.excerpt}</del> → {#if card.proposal?.kind === "text"}<ins>{card.proposal.text}</ins>{:else}<span class="proposal-note">{card.proposal?.text}</span>{/if}
      {:else if card.proposal?.kind === "text"}
        <ins>{card.proposal.text}</ins>
      {:else}
        <span class="proposal-note">{card.proposal?.text}</span>
      {/if}
    </blockquote>
  {/if}
  {#if card.deleted}<p class="card-deleted">{t().textDeleted}</p>{/if}
  {#if card.seeText && onSeeText}
    <button class="quiet see-text" aria-expanded={shown !== undefined} onclick={(event) => { event.stopPropagation(); onSeeText(card); }}>{shown ? t().hideAnnotatedText : t().seeAnnotatedText}</button>
    {#if shown}
      <div class="card-then">
        {#if shown.text}<blockquote class="then-quote">{shown.text.text}</blockquote>{#if shown.text.how}<p class="then-how">{shown.text.how}</p>{/if}{:else}<p class="then-how">{t().textThenUnavailable}</p>{/if}
      </div>
    {/if}
  {/if}
  {#if card.body}<div class="card-body card-text">{@html texts.html(card.body)}</div>{/if}
  {#if card.note}<div class="card-note card-text">{@html texts.html(card.note)}</div>{/if}
  {#if card.replies.length > 0}
    <ol class="card-thread">
      {#each card.replies as reply}
        <li class="card-reply">
          <p class="reply-head"><strong class="reply-author">{reply.author}</strong> <SignatureMark verdict={reply.signature} name={reply.author} onToggle={onResize} /> <span class="reply-when">{reply.when}</span></p>
          <div class="reply-body card-text">{@html texts.html(reply.body)}</div>
        </li>
      {/each}
    </ol>
    <p class="reply-count">{t().replyCount(card.replies.length)}</p>
  {/if}
  {#if card.canReply}
    <!-- Typing or clicking here doesn't select the card again. -->
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="card-reply-box" bind:this={box} onclick={(event) => event.stopPropagation()}>
      {#if replying}
        <textarea
          class="reply-text"
          rows="2"
          bind:value={text}
          bind:this={field}
          aria-label={t().yourReply}
          placeholder={t().yourReply}
          onkeydown={keys}
        ></textarea>
        {#if error}<p class="reply-error" role="alert">{error}</p>{/if}
        <div class="reply-actions">
          <button class="quiet reply-cancel" onclick={closeReply}>{t().cancel}</button>
          <button class="primary reply-send" onclick={send}>{t().send}</button>
        </div>
      {:else}
        <div class="reply-start">
          <button class="quiet reply-open" onclick={openReply}><Icon name="comment" />{t().reply}</button>
          {#if card.awaiting === "awaiting"}
            <button class="quiet set-aside" onclick={() => onSetAside(card.id, true)}>{t().setAside}</button>
          {:else if card.awaiting === "set-aside"}
            <button class="quiet put-back" onclick={() => onSetAside(card.id, false)}>{t().putBack}</button>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
  {#if card.status}<p class="card-status">{card.status}{#if card.decidedBy}, {t().decidedBy(card.decidedBy.name)} <SignatureMark verdict={card.decidedBy.signature} name={card.decidedBy.name} onToggle={onResize} />{/if}</p>{/if}
  {#if card.lost}<p class="decision-lost">{card.lost}</p>{/if}
  {#if card.conflicts.length > 0}<p class="card-conflict">{t().conflictCard}</p>{/if}
  {#if card.actions.length > 0}
    <div class="annotation-actions">
      {#each card.actions as action}
        <button
          class="action-{action}"
          data-action={action}
          onclick={(event) => {
            event.stopPropagation();
            onAction(card.id, action);
          }}><Icon name={ICON[action]} />{LABEL[action]}</button
        >
      {/each}
    </div>
  {/if}
</article>

<style>
  .card {
    position: relative;
    padding: 0.55rem 0.7rem;
    border: 1px solid var(--rule);
    border-left: 3px solid var(--rule);
    border-radius: var(--radius-m);
    background: var(--paper);
    font-size: 0.9rem;
    cursor: pointer;
  }
  .type-comment {
    border-left-color: var(--comment-line);
  }
  .type-addition {
    border-left-color: var(--ins);
  }
  .type-deletion {
    border-left-color: var(--del);
  }
  .type-substitution {
    border-left-color: var(--pencil);
  }
  .card.active {
    border-color: var(--pencil);
    border-left-width: 3px;
    box-shadow: var(--shadow);
  }
  /* Closed (ADR-0052 §1): a dashed border, its text as legible — an
     opacity would lower its contrast. */
  .card.closed {
    border-style: dashed;
    border-left-style: solid;
  }
  /* A key brought forward (ADR-0051 §4): its cards ringed; the others
     on a grey ground, their text as legible — an opacity would lower its
     contrast. */
  .card.brought-forward {
    outline: 2px solid var(--pencil);
    outline-offset: 1px;
  }
  .card.dimmed {
    border-color: transparent;
    background: var(--paper-2);
    box-shadow: none;
  }
  .card-head-line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    column-gap: 0.15rem;
  }
  .card-head {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    align-items: baseline;
    min-width: 0;
    padding: 0;
    border: 0;
    background: transparent;
    text-align: left;
    white-space: normal;
  }
  .card-head:hover {
    background: transparent;
  }
  .verb {
    color: var(--muted);
  }
  blockquote {
    margin: 0.35rem 0;
    padding-left: 0.6rem;
    border-left: 2px solid var(--rule);
    font: 0.9375rem / 1.5 var(--font-doc);
    overflow-wrap: anywhere;
  }
  p {
    margin: 0.3rem 0 0;
  }
  .card-note,
  .card-status,
  .card-deleted,
  .then-how {
    color: var(--muted);
  }
  .card-deleted {
    font-style: italic;
  }
  .see-text {
    display: block;
    width: fit-content;
    margin-top: 0.35rem;
    padding: 0.2rem 0.55rem;
    font-size: 0.85rem;
  }
  .then-how {
    font-size: 0.85rem;
  }
  .card-conflict,
  .decision-lost {
    color: var(--del);
  }
  .proposal-note {
    color: var(--muted);
    font-style: italic;
  }
  .annotation-actions {
    display: flex;
    gap: 0.35rem;
    margin-top: 0.5rem;
  }
  .annotation-actions button {
    padding: 0.2rem 0.55rem;
    font-size: 0.85rem;
  }
  .action-accept,
  .action-resolve {
    color: var(--ins);
  }
  .action-reject {
    color: var(--del);
  }
  .card-thread {
    margin: 0.45rem 0 0;
    padding: 0 0 0 0.6rem;
    border-left: 2px solid var(--rule);
    list-style: none;
  }
  .card-reply + .card-reply {
    margin-top: 0.4rem;
  }
  .card-reply p {
    margin: 0;
  }
  .card-when,
  .reply-when {
    color: var(--muted);
    font-size: 0.8rem;
  }
  .card-when {
    margin-left: 0.2rem;
  }
  /* An annotation's text, rendered (ADR-0047): tight, in the card's width;
     its elements come from {@html}, out of this component's scope. */
  .card-text {
    margin-top: 0.3rem;
    overflow-wrap: anywhere;
  }
  .reply-body {
    margin-top: 0;
  }
  .card-text :global(:is(p, ul, ol, blockquote, pre)) {
    margin: 0.3rem 0 0;
  }
  .card-text :global(:is(p, ul, ol, blockquote, pre):first-child) {
    margin-top: 0;
  }
  .card-text :global(:is(ul, ol)) {
    padding-left: 1.2rem;
  }
  .card-text :global(li > :is(p, ul, ol)) {
    margin: 0;
  }
  /* Not the passage's quote (.card-quote): the card's font, dashed. */
  .card-text :global(blockquote) {
    padding-left: 0.5rem;
    border-left: 2px dashed var(--rule);
    color: var(--muted);
  }
  .card-text :global(code) {
    font-family: var(--font-code);
    font-size: 0.9em;
  }
  .card-text :global(:not(pre) > code) {
    padding: 0 0.2em;
    border-radius: var(--radius-s);
    background: var(--code-bg);
  }
  /* A code block goes to the line rather than scroll: a region that
     scrolls must take the focus (axe), one stop more per card. */
  .card-text :global(pre) {
    padding: 0.35rem 0.5rem;
    border-radius: var(--radius-s);
    background: var(--code-bg);
    white-space: pre-wrap;
  }
  .card-text :global(a) {
    color: var(--pencil);
  }
  /* The count stands for the thread on a folded card only. */
  .reply-count {
    display: none;
    color: var(--muted);
    font-size: 0.85rem;
  }
  .card-reply-box {
    display: grid;
    gap: 0.4rem;
    margin-top: 0.5rem;
    cursor: auto;
  }
  .reply-start {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }
  .reply-start button {
    padding: 0.2rem 0.55rem;
    font-size: 0.85rem;
  }
  /* Awaits my reply (ADR-0050 §5): a dot after the verb, in the head that
     a folded card keeps. */
  .awaiting-mark {
    align-self: center;
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    background: var(--pencil);
  }
  .reply-text {
    width: 100%;
    resize: vertical;
    font: 0.9375rem / 1.5 var(--font-doc);
  }
  .reply-error {
    margin: 0;
    color: var(--del);
  }
  .reply-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.4rem;
  }
</style>
