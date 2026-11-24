import type { Keymap, Scope } from "obsidian";

/** A field where the page takes Mod+Enter: an annotation's text, its why,
 * a reply. */
const FIELD = "textarea, input:not([type]), input[type=text]";

/** Ctrl+Enter (⌘ on macOS) sends an annotation's text in the page, as
 * on the web; Obsidian's keymap takes it first, for its own commands (the
 * link under the caret opened in a new tab), and the field never saw it
 * (checked in the real Obsidian). While a text field of `root` has the
 * focus, `scope` is the active one, and its handler says Mod+Enter is
 * handled: no command runs, and, not `false`, the event is not prevented
 * and goes on to the field. Elsewhere, the text included, Obsidian keeps
 * it. Returns what stops it. */
export function letFieldsTakeModEnter(
  root: HTMLElement,
  keymap: Pick<Keymap, "pushScope" | "popScope">,
  scope: Scope,
): () => void {
  scope.register(["Mod"], "Enter", () => true);
  let pushed = false;
  const isField = (target: EventTarget | null) =>
    target instanceof Element && root.contains(target) && target.matches(FIELD);
  const onFocusIn = (event: FocusEvent) => {
    if (!isField(event.target) || pushed) return;
    keymap.pushScope(scope);
    pushed = true;
  };
  const onFocusOut = (event: FocusEvent) => {
    if (!pushed || isField(event.relatedTarget)) return;
    keymap.popScope(scope);
    pushed = false;
  };
  root.addEventListener("focusin", onFocusIn);
  root.addEventListener("focusout", onFocusOut);
  return () => {
    root.removeEventListener("focusin", onFocusIn);
    root.removeEventListener("focusout", onFocusOut);
    if (pushed) keymap.popScope(scope);
    pushed = false;
  };
}
