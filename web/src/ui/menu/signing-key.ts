import { mount, unmount } from "svelte";
import type { OwnSignature } from "../../view-model/own-signature.svelte.js";
import View from "./SigningKey.svelte";

/** Mounts the signing key of the document menu (`SigningKey.svelte`):
 * shown as `own` knows it. */
export function createSigningKey(
  container: Element,
  options: { own: OwnSignature; copy: (text: string) => Promise<void> },
): { close(): void } {
  const view = mount(View, {
    target: container,
    props: {
      own: options.own,
      onCopy: (text: string) => void options.copy(text),
    },
  });
  return {
    close() {
      void unmount(view);
    },
  };
}
