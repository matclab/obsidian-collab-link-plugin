import { flushSync, mount, unmount } from "svelte";
import type { Role } from "../../../lib/src/index.js";
import View from "./Welcome.svelte";
import { type Hint, rememberHint, seenHints } from "./hints.js";

/** Mounts the first visit's banner (`Welcome.svelte`, ADR-0064, AC1 – AC3) at
 * the start of `container`: for a role that writes or
 * suggests, until « Got it », remembered for the role in this browser. */
export function createWelcome(
  container: Element,
  options: {
    role: Role;
    storage: Storage | undefined;
    onHelp(): void;
    /** Told once « Got it » closed it. */
    onDone?(): void;
  },
): { shown: boolean; close(): void } {
  const { role, storage } = options;
  const hint: Hint | undefined =
    role === "edit"
      ? "welcome-edit"
      : role === "suggest"
        ? "welcome-suggest"
        : undefined;
  if (!hint || seenHints(storage).has(hint)) {
    return { shown: false, close: () => {} };
  }
  const holder = document.createElement("div");
  container.prepend(holder);
  let view: ReturnType<typeof mount> | undefined;
  const close = () => {
    if (!view) return;
    unmount(view);
    view = undefined;
    holder.remove();
  };
  view = mount(View, {
    target: holder,
    props: {
      writer: role === "edit",
      onHelp: () => options.onHelp(),
      onDone: () => {
        rememberHint(storage, hint);
        close();
        options.onDone?.();
      },
    },
  });
  flushSync();
  return { shown: true, close };
}
