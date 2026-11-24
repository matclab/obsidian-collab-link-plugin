<!-- The page's modes: Write, Review (with how many annotations
are open), History. Shows what `view-switch.ts` gives it; acts through its
callback. -->
<script lang="ts">
import { t } from "../../i18n/index.js";

type Mode = "write" | "review" | "history";

interface Props {
  onMode: (mode: Mode) => void;
}
const { onMode }: Props = $props();

let mode = $state<Mode>("write");
let open = $state(0);

export function setMode(next: Mode): void {
  mode = next;
}
export function setOpen(count: number): void {
  open = count;
}
</script>

<div class="modes segmented" role="group" aria-label={t().modes}>
  <button aria-pressed={mode === "write"} onclick={() => onMode("write")}>{t().write}</button>
  <button aria-pressed={mode === "review"} onclick={() => onMode("review")}>
    {t().review}{#if open > 0}<span class="mode-count" aria-label={t().openCount(open)}>{open}</span>{/if}
  </button>
  <button aria-pressed={mode === "history"} onclick={() => onMode("history")}>{t().history}</button>
</div>

<style>
  .mode-count {
    margin-left: 0.35rem;
    min-width: 1.35rem;
    padding: 0 0.35rem;
    border-radius: 999px;
    background: var(--pencil);
    color: var(--on-pencil);
    font-size: 0.75rem;
    line-height: 1.35rem;
    text-align: center;
  }
</style>
