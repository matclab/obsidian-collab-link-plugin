<!-- The page's language, in the document menu: each
named in itself, so that anyone finds theirs. Acts through
`language-field.ts`. -->
<script lang="ts">
import { type Language, currentLanguage, t } from "../../i18n/index.js";

interface Props {
  onChoose: (language: Language) => void;
}
const { onChoose }: Props = $props();

const NAMES: Record<Language, string> = { en: "English", fr: "Français" };
const current = currentLanguage();
</script>

<div class="language">
  <h3>{t().language}</h3>
  <div class="segmented" role="group" aria-label={t().language}>
    {#each Object.entries(NAMES) as [code, name]}
      <button lang={code} aria-pressed={current === code} onclick={() => onChoose(code as Language)}>{name}</button>
    {/each}
  </div>
</div>

<style>
  h3 {
    margin: 0 0 0.4rem;
    font-size: 0.95rem;
  }
</style>
