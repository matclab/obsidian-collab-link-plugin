import { t } from "../../i18n/index.js";

export interface Dialog {
  readonly element: HTMLDialogElement;
  /** Where the dialog's content goes. */
  readonly body: HTMLElement;
  setTitle(title: string): void;
  open(): void;
  close(): void;
}

/** A modal dialog (`<dialog>`): a title, a close button, a
 * body; Escape and a click outside close it, as the browser does. Put in
 * `parent`, its view's element. */
export function createDialog(
  title: string,
  className: string,
  parent: Element,
): Dialog {
  const element = document.createElement("dialog");
  element.className = `dialog ${className}`;
  const head = document.createElement("header");
  const heading = document.createElement("h2");
  heading.textContent = title;
  const close = document.createElement("button");
  close.className = "icon-button dialog-close";
  close.setAttribute("aria-label", t().close);
  close.textContent = "×";
  close.addEventListener("click", () => dialog.close());
  head.append(heading, close);
  const body = document.createElement("div");
  body.className = "dialog-body";
  element.append(head, body);
  element.addEventListener("click", (event) => {
    if (event.target === element) dialog.close();
  });
  parent.append(element);
  const dialog: Dialog = {
    element,
    body,
    setTitle(next) {
      heading.textContent = next;
    },
    open() {
      if (element.open) return;
      // Every browser the page targets has it; jsdom, under the tests,
      // doesn't: the dialog is then merely open.
      if (typeof element.showModal === "function") element.showModal();
      else element.setAttribute("open", "");
    },
    close() {
      if (typeof element.close === "function") element.close();
      else if (element.open) {
        element.removeAttribute("open");
        element.dispatchEvent(new Event("close"));
      }
    },
  };
  return dialog;
}
