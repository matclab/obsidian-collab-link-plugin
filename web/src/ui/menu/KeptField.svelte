<!-- « Garder ce document dans Mes documents » (KR-24),
in the document menu: unchecked, opening the document no longer adds it.
Acts through `kept-field.ts`. -->
<script lang="ts">
import { t } from "../../i18n/index.js";

interface Props {
  setKept: (kept: boolean) => Promise<void>;
}
const { setKept }: Props = $props();

let kept = $state(true);
let busy = $state(false);

export function show(value: boolean): void {
  kept = value;
}

async function toggle(event: Event & { currentTarget: HTMLInputElement }) {
  const next = event.currentTarget.checked;
  busy = true;
  try {
    await setKept(next);
    kept = next;
  } finally {
    busy = false;
  }
}
</script>

<div class="kept">
  <h3>{t().myDocuments}</h3>
  <label class="kept-row">
    <input type="checkbox" class="kept-input" checked={kept} disabled={busy} onchange={toggle} />
    {t().keepThisDocument}
  </label>
  <p class="kept-note">{t().keepThisDocumentNote}</p>
</div>

<style>
  h3 {
    margin: 0 0 0.4rem;
    font-size: 0.95rem;
  }
  .kept-row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .kept-note {
    margin: 0.4rem 0 0;
    color: var(--muted);
    font-size: 0.85rem;
  }
</style>
