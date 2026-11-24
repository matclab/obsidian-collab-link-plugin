/** The dialog of « Vous connecter pour signer de votre nom ? » (`SignToName`
 * decides when it shows and what it lets through): the question, then the
 * sign-in in progress with its
 * « Annuler ». Signed in, the name not carried yet (IC4):
 * why, and « Confirmer », « Réessayer » or the home page. In its view's
 * element. */
import type { PromptView, SignToName } from "../../account/sign-to-name.js";
import { t } from "../../i18n/index.js";
import { createDialog } from "./dialog.js";

export interface SignToNameDialog {
  show(view: PromptView): void;
}

export function createSignToNameDialog(
  parent: Element,
  gate: () => SignToName | undefined,
  options: {
    /** The home page, where the list is seen to. */
    homeHref?: string;
    /** The host's own list, opened instead of the home page. */
    onHome?: () => void;
    /** Why the name isn't carried yet: the identity line's reason. */
    reason?: () => string | undefined;
  } = {},
): SignToNameDialog {
  const dialog = createDialog(t().signToNameTitle, "sign-to-name", parent);
  let shown: PromptView = "hidden";
  // Escape, ×, a click outside: this time only, without remembering.
  dialog.element.addEventListener("close", () => {
    if (shown !== "hidden") gate()?.dismiss();
  });
  const button = (label: string, className: string, run: () => void) => {
    const element = document.createElement("button");
    element.className = className;
    element.textContent = label;
    element.addEventListener("click", run);
    return element;
  };
  const paragraph = (text: string) => {
    const element = document.createElement("p");
    element.textContent = text;
    return element;
  };
  const actions = (...buttons: HTMLElement[]) => {
    const element = document.createElement("div");
    element.className = "dialog-actions";
    element.append(...buttons);
    return element;
  };
  const without = () =>
    button(t().signToNameWithout, "sign-to-name-without", () =>
      gate()?.without(),
    );
  return {
    show(view) {
      shown = view;
      dialog.body.replaceChildren();
      if (view === "hidden") {
        dialog.close();
        return;
      }
      // The sign-in in progress keeps its question's title.
      if (view !== "pending") {
        dialog.setTitle(
          view === "asking" ? t().signToNameTitle : t().signToNameSignedInTitle,
        );
      }
      if (view === "asking") {
        dialog.body.append(
          paragraph(t().signToNameBody),
          actions(
            // In the click: the window opens at once (ADR-0041).
            button(t().signToNameSignIn, "primary sign-to-name-sign-in", () =>
              gate()?.signIn(),
            ),
            without(),
          ),
        );
      } else if (view === "confirm") {
        dialog.body.append(
          paragraph(t().signToNameConfirmBody),
          actions(
            // In the click, recent (IC1).
            button(t().identityConfirm, "primary sign-to-name-confirm", () =>
              gate()?.confirm(),
            ),
            without(),
          ),
        );
      } else if (view === "unconfirmed") {
        dialog.body.append(
          paragraph(t().identityUnconfirmed),
          actions(
            button(t().identityRetry, "primary sign-to-name-retry", () =>
              gate()?.retry(),
            ),
            without(),
          ),
        );
      } else if (view === "home") {
        // Seen to elsewhere (the host's list, another tab): what is
        // written goes on without.
        const { onHome } = options;
        let home: HTMLElement;
        if (onHome) {
          home = button(t().identityChooseHome, "sign-to-name-home", () => {
            onHome();
            gate()?.without();
          });
        } else {
          const link = document.createElement("a");
          link.className = "sign-to-name-home";
          link.href = options.homeHref ?? "/";
          link.target = "_blank";
          link.rel = "noopener";
          link.textContent = t().identityChooseHome;
          link.addEventListener("click", () => gate()?.without());
          home = link;
        }
        dialog.body.append(
          paragraph(options.reason?.() ?? t().identityNotYet),
          actions(home, without()),
        );
      } else {
        const text = paragraph(t().signInPending);
        text.setAttribute("role", "status");
        const note = paragraph(t().signInWindowNote);
        note.className = "muted";
        dialog.body.append(
          text,
          note,
          button(t().signInCancel, "sign-to-name-cancel", () =>
            gate()?.cancel(),
          ),
        );
      }
      dialog.open();
    },
  };
}
