import { flushSync, mount } from "svelte";
import Field from "./PseudonymField.svelte";

/** Mounts the pseudonym field (`PseudonymField.svelte`, ADR-0008, phase 7
 * decision 9). `save` stores a name and returns it as kept (trimmed), or
 * `undefined` to refuse it; `onRenamed` is told the name kept. `show`
 * puts a name in it: the identity's, not to change, while signed in. */
export function createPseudonymField(
  container: Element,
  options: {
    name: string;
    save: (name: string) => string | undefined;
    onRenamed: (name: string) => void;
  },
): { show(name: string, fromIdentity: boolean): void } {
  const field = mount(Field, {
    target: container,
    props: {
      name: options.name,
      save(name: string) {
        const kept = options.save(name);
        if (kept !== undefined) options.onRenamed(kept);
        return kept;
      },
    },
  });
  flushSync();
  return {
    show(name, fromIdentity) {
      field.show(name, fromIdentity);
      flushSync();
    },
  };
}
