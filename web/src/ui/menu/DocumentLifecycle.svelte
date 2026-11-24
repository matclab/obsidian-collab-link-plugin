<!-- The document's expiry (ADR-0023), in the document menu: shown to
every role; for an editor, set by duration or by date, or removed. Shows
what `document-lifecycle.ts` gives it; acts through its callbacks, with
the fields read at the time of the action. -->
<script lang="ts">
import type { Role } from "../../../lib/src/index.js";
import { t } from "../../i18n/index.js";

interface Props {
  role: Role;
  onExpireIn: (count: string, unit: string) => void;
  onExpireOn: (value: string) => void;
  onRemove: () => void;
}
const { role, onExpireIn, onExpireOn, onRemove }: Props = $props();
// Unique in the window: several views may share it.
const uid = $props.id();

let description = $state("");
let expiring = $state(false);
let error = $state<string | undefined>(undefined);
let gone = $state(false);
// biome-ignore lint/style/useConst: assigned by bind:this in the template.
let count = $state<HTMLInputElement>();
// biome-ignore lint/style/useConst: assigned by bind:this in the template.
let unit = $state<HTMLSelectElement>();
// biome-ignore lint/style/useConst: assigned by bind:this in the template.
let date = $state<HTMLInputElement>();

export function show(expiresAt: number | null, text: string) {
  description = text;
  expiring = expiresAt !== null;
  error = undefined;
}

export function fail(message: string) {
  error = message;
}

export function deleted() {
  gone = true;
  error = undefined;
}
</script>

<div class="lifecycle">
  <h3>{t().expiry}</h3>
  {#if gone}
    <p class="lifecycle-expiry">{t().deletedFromServer}</p>
  {:else}
    <p class="lifecycle-expiry">{description}</p>
    {#if role === "edit"}
      <div class="lifecycle-row">
        <label for="{uid}-expire-in">{t().expireIn}</label>
        <input id="{uid}-expire-in" class="expire-in-count" type="number" min="1" step="1" value="7" bind:this={count} />
        <select class="expire-in-unit" aria-label={t().expiryUnit} bind:this={unit}>
          <option value="hours">{t().hours}</option>
          <option value="days" selected>{t().days}</option>
          <option value="weeks">{t().weeks}</option>
        </select>
        <button class="expire-in-set" onclick={() => onExpireIn(count?.value ?? "", unit?.value ?? "")}>{t().set}</button>
      </div>
      <div class="lifecycle-row">
        <label for="{uid}-expire-on">{t().expireOn}</label>
        <input id="{uid}-expire-on" class="expire-on-date" type="datetime-local" bind:this={date} />
        <button class="expire-on-set" onclick={() => onExpireOn(date?.value ?? "")}>{t().set}</button>
      </div>
      {#if expiring}
        <button class="expire-remove quiet" onclick={onRemove}>{t().removeExpiry}</button>
      {/if}
    {/if}
    {#if error}
      <p class="lifecycle-error" role="alert">{error}</p>
    {/if}
  {/if}
</div>

<style>
  h3 {
    margin: 0 0 0.4rem;
    font-size: 0.95rem;
  }
  p {
    margin: 0 0 0.5rem;
  }
  .lifecycle-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
    margin: 0 0 0.4rem;
  }
  .expire-in-count {
    width: 4.5rem;
  }
  .lifecycle-error {
    color: var(--del);
  }
</style>
