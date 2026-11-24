import { flushSync, mount, unmount } from "svelte";
import type { Role } from "../../../lib/src/index.js";
import View from "./Header.svelte";
import type { IdentityAction, IdentityChip } from "./identity-line.js";
import type { SyncState } from "./sync-state.js";

export interface Header {
  /** Where the modes go (`createViewSwitch`'s `modesParent`). */
  readonly modes: HTMLElement;
  /** Where who is here goes (`createHereNow`). */
  readonly presence: HTMLElement;
  setTitle(title: string | undefined): void;
  /** Unknown (`undefined`) while this browser keeps nothing locally. */
  setSync(state: SyncState | undefined): void;
  /** Signed in, why the name isn't carried yet: a chip that acts
   * (IC5); signed out, the sign-in, and signing in, its
   * cancel (IC5 precised); none when all is well, or without gateway. */
  setIdentity(chip: IdentityChip | undefined): void;
  destroy(): void;
}

/** Mounts the page's header (`Header.svelte`). */
export function createHeader(
  container: Element,
  options: {
    role: Role;
    onShare: () => void;
    onDocument: () => void;
    /** The home page, where the list is seen to. */
    homeHref?: string;
    /** The host's own list, opened instead of the home page. */
    onHome?: () => void;
    /** In the click: « Confirmer » (a recent sign-in), « Réessayer »,
     * « S'identifier », « Annuler ». */
    onIdentity?: (action: IdentityAction) => void;
  },
): Header {
  const view = mount(View, { target: container, props: options });
  flushSync();
  const { modes, presence } = view.places();
  return {
    modes,
    presence,
    setTitle(title) {
      view.setTitle(title);
      flushSync();
    },
    setSync(state) {
      view.setSync(state);
      flushSync();
    },
    setIdentity(chip) {
      view.setIdentity(chip);
      flushSync();
    },
    destroy() {
      void unmount(view);
    },
  };
}
