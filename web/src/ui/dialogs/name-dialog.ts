import { t } from "../../i18n/index.js";
import { createDialog } from "./dialog.js";

/** Asks the name this browser shows on comments and suggestions, the
 * first time it writes (instead of `window.prompt`): modal, so
 * that nothing is written before the answer. Resolves with what was typed,
 * or `null` if the dialog was closed. */
export function askName(parent: Element): Promise<string | null> {
  const dialog = createDialog(t().chooseName, "name-dialog", parent);
  const note = document.createElement("p");
  note.className = "name-note";
  note.textContent = t().choosePseudonym;
  const input = document.createElement("input");
  input.className = "name-input";
  input.maxLength = 200;
  input.setAttribute("aria-label", t().yourName);
  const unverified = document.createElement("p");
  unverified.className = "name-note muted";
  unverified.textContent = t().nameNote;
  const go = document.createElement("button");
  go.className = "name-continue primary";
  go.textContent = t().continue;
  const row = document.createElement("div");
  row.className = "name-row";
  row.append(input, go);
  dialog.body.append(note, row, unverified);
  return new Promise((resolve) => {
    let answer: string | null = null;
    const done = () => {
      answer = input.value;
      dialog.close();
    };
    go.addEventListener("click", done);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") done();
    });
    dialog.element.addEventListener("close", () => {
      dialog.element.remove();
      resolve(answer);
    });
    dialog.open();
    input.focus();
  });
}
