<!-- The share dialog's content (ADR-0019): for an editor, the document's
three links, what each role may do, copy; renewing them all, folded away
with what it does. Another role only sees its own. Shows what
`share-panel.ts` gives it; acts through its callbacks. -->
<script lang="ts">
import type { Role } from "../../../lib/src/index.js";
import { t } from "../../i18n/index.js";

interface Props {
  role: Role;
  onRenew: () => void;
  onCopy: (text: string) => void;
}
const { role, onRenew, onCopy }: Props = $props();
// Unique in the window: several views may share it.
const uid = $props.id();

const ROLES = ["read", "suggest", "edit"] as const;
const LABELS: Record<Role, string> = {
  read: t().roleRead,
  suggest: t().roleSuggest,
  edit: t().roleEdit,
};
const MAY: Record<Role, string> = {
  read: t().roleReadMay,
  suggest: t().roleSuggestMay,
  edit: t().roleEditMay,
};

let links = $state<Record<Role, string> | undefined>(undefined);
let renewed = $state(false);
let copied = $state<Role | undefined>(undefined);

export function setLinks(next: Record<Role, string>, isRenewal: boolean) {
  links = next;
  renewed = isRenewal;
}

function copy(linkRole: Role) {
  onCopy(links?.[linkRole] ?? "");
  copied = linkRole;
}
</script>

<div class="share-panel">
  {#if role !== "edit"}
    <p class="share-role">{t().yourAccess(LABELS[role])}</p>
    <p class="muted">{MAY[role]}</p>
  {:else if links}
    {#if renewed}
      <p class="share-renewed" role="status">{t().linksRenewed}</p>
    {/if}
    <p class="muted">{t().shareIntro}</p>
    {#each ROLES as linkRole}
      <div class="share-link">
        <label for="{uid}-share-{linkRole}"><strong>{LABELS[linkRole]}</strong> <span class="muted">{MAY[linkRole]}</span></label>
        <div class="share-row">
          <input id="{uid}-share-{linkRole}" class="share-{linkRole}" readonly value={links[linkRole]} />
          <button class="copy-{linkRole}" onclick={() => copy(linkRole)}>{copied === linkRole ? t().copied : t().copy}</button>
        </div>
      </div>
    {/each}
    <details class="renew">
      <summary>{t().renewOpen}</summary>
      <p class="muted">{t().renewWarning}</p>
      <button class="renew-button danger" onclick={onRenew}>{t().renewLinks}</button>
    </details>
  {/if}
</div>

<style>
  .share-panel {
    display: grid;
    gap: 0.9rem;
  }
  p {
    margin: 0;
  }
  .muted {
    color: var(--muted);
  }
  .share-link label {
    display: block;
    margin-bottom: 0.3rem;
  }
  .share-row {
    display: flex;
    gap: 0.5rem;
  }
  .share-row input {
    flex: 1;
    min-width: 0;
    font-family: var(--font-code);
    font-size: 0.8rem;
    color: var(--muted);
  }
  .share-renewed {
    padding: 0.5rem 0.75rem;
    border-radius: var(--radius-s);
    background: var(--warn-bg);
  }
  .renew summary {
    cursor: pointer;
    color: var(--muted);
  }
  .renew p {
    margin: 0.5rem 0;
  }
</style>
