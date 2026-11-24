<!-- The pseudonym of this browser (ADR-0008), in the document menu: a
field, said not to be verified (phase 7 decision 9). Acts through
`pseudonym-field.ts`; the field is read when saving. -->
<script lang="ts">
import { t } from "../../i18n/index.js";

interface Props {
  name: string;
  save: (name: string) => string | undefined;
}
const { name: initial, save }: Props = $props();

let error = $state(false);
// Signed in: the identity's name, not changed here (18o.2, 2026-10-20).
// svelte-ignore state_referenced_locally
let shown = $state(initial);
let fromIdentity = $state(false);

export function show(name: string, identity: boolean): void {
  shown = name;
  fromIdentity = identity;
  error = false;
  if (input) input.value = name;
}
// biome-ignore lint/style/useConst: assigned by bind:this in the template.
let input = $state<HTMLInputElement>();

function submit() {
  const kept = save(input?.value ?? "");
  if (kept === undefined) {
    error = true;
    return;
  }
  if (input) input.value = kept;
  shown = kept;
  error = false;
}
</script>

<div class="pseudonym">
  <h3>{t().yourName}</h3>
  <div class="pseudonym-row">
    <input class="pseudonym-input" value={shown} disabled={fromIdentity} maxlength="200" aria-label={t().yourName} bind:this={input} onkeydown={(event) => event.key === "Enter" && submit()} />
    {#if !fromIdentity}
      <button class="pseudonym-save" onclick={submit}>{t().save}</button>
    {/if}
  </div>
  {#if error}
    <p class="pseudonym-error" role="alert">{t().nameLength}</p>
  {/if}
  <p class="pseudonym-note">{fromIdentity ? t().nameOfIdentity : t().nameNote}</p>
</div>

<style>
  h3 {
    margin: 0 0 0.4rem;
    font-size: 0.95rem;
  }
  .pseudonym-row {
    display: flex;
    gap: 0.5rem;
  }
  .pseudonym-input {
    flex: 1;
    min-width: 0;
  }
  .pseudonym-input:disabled {
    color: var(--muted);
  }
  p {
    margin: 0.4rem 0 0;
  }
  .pseudonym-note {
    color: var(--muted);
    font-size: 0.85em;
  }
  .pseudonym-error {
    color: var(--del);
  }
</style>
