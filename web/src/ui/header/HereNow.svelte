<!-- Who else is here (ADR-0025 §7), in the header: a dot per person, the
initial of the name they chose, the name itself on hover; the group says
the names are not verified — a signed one carries a key, and its short
fingerprint in what is said of it (docs/protocol/06-identity.md). Shows
what `here-now.ts` gives it. -->
<script lang="ts">
import { t } from "../../i18n/index.js";

interface Other {
  name: string;
  color: string;
  /** Its key's short fingerprint, if signed. */
  short?: string;
  /** Who attests its name, if attested (ID-39). */
  issuer?: string;
}

let others = $state<Other[]>([]);

export function show(next: Other[]) {
  others = next;
}

const said = (other: Other) =>
  other.issuer
    ? t().attestedNameLabel(other.name, other.issuer)
    : other.short
      ? t().signedNameLabel(other.name, other.short)
      : other.name;

const initial = (name: string) =>
  (Array.from(name.trim())[0] ?? "?").toLocaleUpperCase();
const summary = $derived(
  others.length === 0
    ? t().nobodyElse
    : `${t().hereNow} ${others.map(said).join(", ")}. ${t().namesNotVerified}`,
);
</script>

<div class="presence" role="group" aria-label={summary} title={summary}>
  {#each others as other}
    <span class="avatar" class:signed={other.short !== undefined} style="--person: {other.color}" title={said(other)}>{initial(other.name)}</span>
  {/each}
</div>

<style>
  .presence {
    display: flex;
    align-items: center;
    min-height: 28px;
  }
  .avatar {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    margin-left: -6px;
    border-radius: 50%;
    border: 2px solid var(--paper);
    background: var(--person);
    color: var(--on-color);
    font-size: 0.8rem;
    font-weight: 600;
  }
  .avatar:first-child {
    margin-left: 0;
  }
  /* Signed: a ring of the text's colour around the dot. */
  .avatar.signed {
    outline: 2px solid var(--ink);
    outline-offset: 1px;
  }
</style>
