import { t } from "../../i18n/index.js";

export interface Notices {
  /** Shows `text`, newest first, once however often it is said; with
   * `action`, a button that does what the text asks — said again, the
   * newest action, in place of the one shown; done, the notice goes. */
  show(text: string, action?: { label: string; run: () => void }): void;
}

/** What the page has to say: a list under the header, never
 * over the text; each can be dismissed. */
export function createNotices(container: Element): Notices {
  return {
    show(text, action) {
      const already = Array.from(
        container.querySelectorAll(".notice-text"),
      ).find((shown) => shown.textContent === text);
      if (already && !action) return;
      already?.parentElement?.remove();
      const notice = document.createElement("div");
      notice.className = "notice";
      notice.setAttribute("role", "alert");
      const line = document.createElement("span");
      line.className = "notice-text";
      line.textContent = text;
      notice.append(line);
      if (action) {
        const button = document.createElement("button");
        button.className = "notice-action";
        button.textContent = action.label;
        button.addEventListener("click", () => {
          notice.remove();
          action.run();
        });
        notice.append(button);
      }
      const dismiss = document.createElement("button");
      dismiss.className = "notice-dismiss icon-button";
      dismiss.setAttribute("aria-label", t().dismiss);
      dismiss.textContent = "×";
      dismiss.addEventListener("click", () => notice.remove());
      notice.append(dismiss);
      container.prepend(notice);
    },
  };
}
