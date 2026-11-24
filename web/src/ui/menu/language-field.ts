import { flushSync, mount } from "svelte";
import {
  LANGUAGE_KEY,
  type Language,
  currentLanguage,
} from "../../i18n/index.js";
import Field from "./LanguageField.svelte";

/** Mounts the language choice (`LanguageField.svelte`): the one chosen is
 * kept in this browser, and the page reloads to show it — the connection
 * and the local copy pick up where they were. */
export function createLanguageField(
  container: Element,
  options: {
    storage: Pick<Storage, "setItem"> | undefined;
    reload: () => void;
  },
): void {
  mount(Field, {
    target: container,
    props: {
      onChoose(language: Language) {
        if (language === currentLanguage()) return;
        options.storage?.setItem(LANGUAGE_KEY, language);
        options.reload();
      },
    },
  });
  flushSync();
}
