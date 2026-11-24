<!-- Over the text, in Write: opens and closes the outline (phase 16,
decision 1). Shows what `outline-column.ts` gives it. -->
<script lang="ts">
import { t } from "../../i18n/index.js";
import Icon from "../Icon.svelte";

interface Props {
  onToggle: () => void;
}
const { onToggle }: Props = $props();

let open = $state(false);
let controls = $state("");
let shown = $state(true);
// biome-ignore lint/style/useConst: assigned by bind:this in the template.
let button = $state<HTMLButtonElement>();

export function set(next: {
  open: boolean;
  shown: boolean;
  controls: string;
}): void {
  open = next.open;
  shown = next.shown;
  controls = next.controls;
}

export function focus(): void {
  button?.focus();
}
</script>

<button
  class="quiet outline-toggle"
  bind:this={button}
  hidden={!shown}
  aria-expanded={open}
  aria-controls={controls}
  title={open ? t().hideOutline : t().showOutline}
  onclick={onToggle}><Icon name="outline" />{t().outline}</button>

<style>
  /* First of the tools over the text, apart from the others. */
  .outline-toggle {
    margin-right: auto;
  }
</style>
