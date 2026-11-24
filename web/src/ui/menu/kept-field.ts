import { flushSync, mount } from "svelte";
import Field from "./KeptField.svelte";

/** Mounts « Garder ce document dans Mes documents » (`KeptField.svelte`):
 * checked as the keyring says, once it has said. */
export function createKeptField(
  container: Element,
  options: {
    isKept: () => Promise<boolean>;
    setKept: (kept: boolean) => Promise<void>;
  },
): void {
  const field = mount(Field, {
    target: container,
    props: { setKept: options.setKept },
  });
  flushSync();
  void options.isKept().then((kept) => {
    field.show(kept);
    flushSync();
  });
}
