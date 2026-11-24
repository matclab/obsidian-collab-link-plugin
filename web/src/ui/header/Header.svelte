<!-- The page's header: the document's title (never the tab's,
decision 5), the role of a link that cannot edit, the modes and who is
here (mounted by others in their places), where this browser's changes
are, sharing for an editor, and the document menu. Shows what
`header.ts` gives it; acts through its callbacks. -->
<script lang="ts">
import type { Role } from "../../../lib/src/index.js";
import { t } from "../../i18n/index.js";
import Icon from "../Icon.svelte";
import type { IdentityAction, IdentityChip } from "./identity-line.js";
import type { SyncState } from "./sync-state.js";

interface Props {
  role: Role;
  onShare: () => void;
  onDocument: () => void;
  homeHref?: string;
  onHome?: () => void;
  onIdentity?: (action: IdentityAction) => void;
}
const {
  role,
  onShare,
  onDocument,
  homeHref = "/",
  onHome,
  onIdentity,
}: Props = $props();

let title = $state<string | undefined>(undefined);
let sync = $state<SyncState | undefined>(undefined);
let identity = $state<IdentityChip | undefined>(undefined);
// biome-ignore lint/style/useConst: assigned by bind:this in the template.
let modes = $state<HTMLElement>();
// biome-ignore lint/style/useConst: assigned by bind:this in the template.
let presence = $state<HTMLElement>();

export function setTitle(next: string | undefined): void {
  title = next;
}
export function setSync(next: SyncState | undefined): void {
  sync = next;
}
export function setIdentity(next: IdentityChip | undefined): void {
  identity = next;
}
export function places(): { modes: HTMLElement; presence: HTMLElement } {
  if (!modes || !presence) throw new Error("header not mounted");
  return { modes, presence };
}

const ROLE = {
  read: t().roleRead,
  suggest: t().roleSuggest,
  edit: t().roleEdit,
};
const SYNC = {
  saved: [t().syncSaved, t().syncSavedTitle],
  sending: [t().syncSending, t().unsentTitle],
  offline: [t().syncOffline, t().unsentTitle],
} as const;
const IDENTITY = {
  confirm: t().identityConfirm,
  unconfirmed: t().identityChipRetry,
  associate: t().identityChipAssociate,
  "open-here": t().identityChipOpenHere,
  other: t().identityChipOther,
  "sign-in": t().signIn,
  pending: t().identityChipCancel,
  "new-key": t().identityChipNewKey,
} as const;
</script>

<div class="topbar">
  <h1 class="doc-title" title={title ?? t().untitled}>{title ?? t().untitled}</h1>
  {#if role !== "edit"}<span class="role-badge">{ROLE[role]}</span>{/if}
  <div class="topbar-modes" bind:this={modes}></div>
  <div class="spacer"></div>
  <div class="topbar-presence" bind:this={presence}></div>
  {#if sync}
    <span class="sync" data-state={sync} title={SYNC[sync][1]}><span class="sync-dot"></span>{SYNC[sync][0]}</span>
  {/if}
  {#if (identity === "associate" || identity === "open-here" || identity === "other") && onHome}
    <button class="identity-chip" aria-label={IDENTITY[identity]} title={IDENTITY[identity]} onclick={onHome}><Icon name="unverified" /><span class="label">{IDENTITY[identity]}</span></button>
  {:else if identity === "associate" || identity === "open-here" || identity === "other"}
    <a class="identity-chip" href={homeHref} target="_blank" rel="noopener" aria-label={IDENTITY[identity]} title={IDENTITY[identity]}><Icon name="unverified" /><span class="label">{IDENTITY[identity]}</span></a>
  {:else if identity}
    {@const action = identity}
    <button class="identity-chip" aria-label={IDENTITY[action]} title={IDENTITY[action]} onclick={() => onIdentity?.(action)}><Icon name={action === "sign-in" || action === "pending" ? "signIn" : "unverified"} /><span class="label">{IDENTITY[action]}</span></button>
  {/if}
  {#if role === "edit"}
    <button class="share-button primary" aria-label={t().share} title={t().share} onclick={onShare}><Icon name="share" /><span class="label">{t().share}</span></button>
  {/if}
  <button class="document-button" aria-label={t().document} title={t().document} onclick={onDocument}><Icon name="file" /><span class="label">{t().document}</span></button>
</div>

<style>
  .topbar {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.5rem 1rem;
    min-height: 3.25rem;
  }
  .doc-title {
    margin: 0;
    font: 600 1rem / 1.3 var(--font-ui);
    min-width: 0;
    max-width: 22rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .role-badge {
    font-size: 0.75rem;
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    background: var(--pencil-bg);
    color: var(--pencil);
    white-space: nowrap;
  }
  /* The modes, the view chosen on a wide view (`view-switch.ts`), then
     what awaits my reply (ADR-0050 §5): on one line, the title gives
     way. */
  .topbar-modes {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.5rem;
    margin-left: 0.75rem;
  }
  .spacer {
    flex: 1;
  }
  .identity-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.25rem 0.65rem;
    border: 1px solid var(--pencil);
    border-radius: 999px;
    background: var(--pencil-bg);
    color: var(--pencil);
    font-size: 0.85rem;
    white-space: nowrap;
    text-decoration: none;
    cursor: pointer;
  }
  .document-button {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    white-space: nowrap;
  }
  .sync {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--muted);
    font-size: 0.85rem;
    white-space: nowrap;
  }
  .sync-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--ins);
  }
  .sync[data-state="sending"] .sync-dot {
    background: var(--pencil);
  }
  .sync[data-state="offline"] {
    color: var(--ink);
  }
  .sync[data-state="offline"] .sync-dot {
    background: var(--comment-line);
  }
  /* The view chosen beside the modes (ADR-0065, VF1): the buttons'
     icons alone, their names in their tooltips, as on a narrow view. */
  .topbar:has(:global(.view-switch)) .label {
    display: none;
  }
  .topbar:has(:global(.view-switch)) :is(.identity-chip, .document-button) {
    padding: 0.3rem;
  }
  @container document-view (max-width: 56.25rem) {
    .topbar {
      flex-wrap: wrap;
      padding: 0.5rem 0.75rem;
      gap: 0.5rem;
    }
    .doc-title {
      flex: 1;
      max-width: none;
    }
    .spacer {
      display: none;
    }
    .topbar-modes {
      order: 10;
      flex-basis: 100%;
      flex-wrap: wrap;
      margin: 0;
    }
    .label {
      display: none;
    }
    .identity-chip,
    .document-button {
      padding: 0.3rem;
    }
    .sync {
      font-size: 0;
      gap: 0;
    }
  }
</style>
