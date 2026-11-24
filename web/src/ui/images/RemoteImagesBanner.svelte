<!-- A document's remote images (ADR-0055 §4, §5, §7, §14): how many are
not shown and from where, what showing them tells, « Show » for this
opening, « Always for this document »; once granted, a line that says so
and takes it back. -->
<script lang="ts">
import { t } from "../../i18n/index.js";
import type { DocumentGrant } from "../../view-model/remote-images.js";

interface Props {
  onShow: (always: boolean) => void;
  onStop: () => void;
}
const { onShow, onStop }: Props = $props();

let total = $state(0);
let hosts = $state<string[]>([]);
let hidden = $state(0);
let grant = $state<DocumentGrant>("none");

/** The text's remote images, those not shown and their hosts, and the
 * document's grant. */
export function set(next: {
  total: number;
  hidden: number;
  hosts: string[];
  grant: DocumentGrant;
}): void {
  total = next.total;
  hidden = next.hidden;
  hosts = next.hosts;
  grant = next.grant;
}

const listed = $derived(
  hosts.length > 3
    ? `${hosts.slice(0, 3).join(", ")} ${t().remoteImagesMore(hosts.length - 3)}`
    : hosts.join(", "),
);
</script>

{#if grant === "none" && hidden > 0}
  <div class="remote-images-banner">
    <p class="remote-images-said">
      <strong>{t().remoteImagesHidden(hidden, listed)}</strong>
      {t().remoteImagesWarning}
    </p>
    <p class="remote-images-actions">
      <button class="quiet" onclick={() => onShow(false)}>{t().remoteImagesShow}</button>
      <button class="quiet" onclick={() => onShow(true)}>{t().remoteImagesAlways}</button>
      <span class="remote-images-note">{t().remoteImagesAlwaysNote}</span>
    </p>
  </div>
{:else if grant !== "none" && total > 0}
  <p class="remote-images-granted">
    {grant === "always" ? t().remoteImagesShownAlways : t().remoteImagesShown}
    <button class="quiet" onclick={onStop}>{t().remoteImagesStop}</button>
  </p>
{/if}

<style>
  .remote-images-banner {
    margin: 0 0 0.75rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--rule);
    border-left: 3px solid var(--comment-line);
    border-radius: 4px;
    background: var(--warn-bg);
    font-size: 0.85rem;
  }
  .remote-images-said,
  .remote-images-actions {
    margin: 0;
  }
  .remote-images-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem 0.5rem;
    margin-top: 0.4rem;
  }
  .remote-images-note,
  .remote-images-granted {
    color: var(--muted);
    font-size: 0.8rem;
  }
  .remote-images-granted {
    margin: 0 0 0.5rem;
  }
</style>
