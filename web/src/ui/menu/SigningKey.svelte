<!-- The signing key of the document menu (ADR-0051): the fingerprint of
the key this browser signs with, to give who asks to check, and to copy;
told apart from the key of « Mes documents », which is never given.
Nothing until the key is known, nor without one. -->
<script lang="ts">
import { t } from "../../i18n/index.js";
import type { OwnSignature } from "../../view-model/own-signature.svelte.js";

interface Props {
  own: OwnSignature;
  onCopy: (text: string) => void;
}
const { own, onCopy }: Props = $props();

// biome-ignore lint/style/useConst: assigned in the template.
let copied = $state(false);
</script>

{#if own.short}
  <h3>{t().signingKeyTitle}</h3>
  <p>{t().signingKeyIntro}</p>
  <div class="signing-key-row">
    <code>{own.short}</code>
    <button
      class="signing-key-copy"
      onclick={() => {
        onCopy(own.short ?? "");
        copied = true;
      }}
    >{copied ? t().copied : t().copy}</button>
  </div>
  <p class="muted">{t().signingKeyGive}</p>
  <p class="muted">{t().signingKeyNotKeyring}</p>
{/if}

<style>
  h3 {
    margin: 0 0 0.4rem;
    font-size: 0.95rem;
  }
  p {
    margin: 0.25rem 0;
  }
  .muted {
    color: var(--muted);
  }
  .signing-key-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin: 0.25rem 0;
  }
  code {
    font-size: 0.95rem;
  }
</style>
