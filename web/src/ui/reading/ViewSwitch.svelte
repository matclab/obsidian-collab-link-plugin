<!-- In Write: the view chosen, one of three (ADR-0064, AC8) — the
formatted text (phase 11), its source (decision 4), Reading (ADR-0021
§1) —, then Source's side by side (AC9), its place kept on a wide screen
where it isn't offered: choosing a view moves no button. Beside the modes,
or first over the text on a narrow view (`view-switch.ts`, which places
it). Shows what `view-switch.ts` gives it; acts through its callbacks. -->
<script lang="ts">
import { t } from "../../i18n/index.js";
import type { ViewChoice } from "./view-switch.js";

interface Props {
  onChoose: (view: ViewChoice) => void;
  onSideBySide: () => void;
}
const { onChoose, onSideBySide }: Props = $props();

let view = $state<ViewChoice>("formatted");
let side = $state(false);
let sideWide = $state(false);
let sideOffered = $state(false);

export function setView(next: ViewChoice): void {
  view = next;
}

/** Side by side, whether the screen has room for it, and whether it is
 * offered: in Source, wide. */
export function setSideBySide(
  next: boolean,
  wide: boolean,
  offered: boolean,
): void {
  side = next;
  sideWide = wide;
  sideOffered = offered;
}
</script>

<div class="view-choice segmented" role="group" aria-label={t().viewChoice}>
  <button class="formatted-toggle" aria-pressed={view === "formatted"} onclick={() => onChoose("formatted")}>{t().formatted}</button>
  <button class="source-toggle" aria-pressed={view === "source"} onclick={() => onChoose("source")}>{t().source}</button>
  <button class="preview-toggle" aria-pressed={view === "reading"} title={t().previewHelp} onclick={() => onChoose("reading")}>{t().preview}</button>
</div>
<button class="side-toggle quiet" aria-pressed={side} hidden={!sideWide} inert={!sideOffered} onclick={onSideBySide}>{t().sideBySide}</button>

<style>
  /* Its place kept, unseen. */
  .side-toggle[inert] {
    visibility: hidden;
  }
</style>
