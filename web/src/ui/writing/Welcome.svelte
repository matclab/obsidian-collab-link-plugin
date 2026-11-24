<!-- The first visit's banner (ADR-0064, AC1): over the text,
what the page is for one who arrives by a link. Closed by « Got it » only
(AC2). Announced, never taking the focus. Shows what `welcome.ts` gives
it; acts through its callbacks. -->
<script lang="ts">
import { t } from "../../i18n/index.js";

interface Props {
  /** A writer's banner (Markdown, the help), else a suggester's. */
  writer: boolean;
  onHelp: () => void;
  onDone: () => void;
}
const { writer, onHelp, onDone }: Props = $props();
</script>

<div class="notice welcome" role="status">
  <div class="notice-text welcome-body">
    <p>{writer ? t().welcomeWriter : t().welcomeSuggester}</p>
    <div class="welcome-actions">
      {#if writer}
        <button class="welcome-help quiet" onclick={onHelp}>{t().welcomeHelp}</button>
      {/if}
      <button class="welcome-done" onclick={onDone}>{t().welcomeDone}</button>
    </div>
  </div>
</div>

<style>
  .welcome {
    border-left-color: var(--pencil);
    background: var(--pencil-bg);
  }
  /* Its buttons beside the text where there is room, else under it. */
  .welcome-body {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 1rem;
  }
  p {
    flex: 1 1 28rem;
    margin: 0;
  }
  .welcome-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-left: auto;
  }
</style>
