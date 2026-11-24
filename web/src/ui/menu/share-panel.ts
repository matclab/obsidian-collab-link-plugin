import { flushSync, mount, unmount } from "svelte";
import type { Role } from "../../../lib/src/index.js";
import { t } from "../../i18n/index.js";
import Panel from "./SharePanel.svelte";

export interface SharePanel {
  /** Shows the document's links; `renewed` after a rotation. */
  setLinks(links: Record<Role, string>, renewed: boolean): void;
  destroy(): void;
}

/** Mounts the share panel (`SharePanel.svelte`). Renewing asks
 * `confirm` first: it cuts everyone (ADR-0019 §5). */
export function createSharePanel(
  container: Element,
  options: {
    role: Role;
    links: Record<Role, string> | undefined;
    onRenew: () => Promise<void>;
    confirm: (message: string) => boolean;
    copy: (text: string) => Promise<void>;
  },
): SharePanel {
  const panel = mount(Panel, {
    target: container,
    props: {
      role: options.role,
      onRenew() {
        const accepted = options.confirm(t().renewConfirm);
        if (accepted) void options.onRenew();
      },
      onCopy(text: string) {
        void options.copy(text);
      },
    },
  });
  const setLinks = (links: Record<Role, string>, renewed: boolean) => {
    panel.setLinks(links, renewed);
    flushSync();
  };
  if (options.links) setLinks(options.links, false);
  flushSync();
  return {
    setLinks,
    destroy() {
      void unmount(panel);
    },
  };
}
