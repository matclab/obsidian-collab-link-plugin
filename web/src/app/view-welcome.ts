import { StateEffect } from "@codemirror/state";
import type { Role } from "../../lib/src/index.js";
import { firstHints } from "../editor/first-hints.js";
import { rememberHint, seenHints } from "../ui/writing/hints.js";
import { createWelcome } from "../ui/writing/welcome.js";
import type { WiredClient } from "./wire-client.js";

/** The first visit (ADR-0064), where asked: its banner (AC1 – AC3), then
 * the hints in the editor, once it is closed or if there is none (AC6).
 * `wired` tells it the editor is there. */
export function followWelcome(options: {
  /** Asked: the page; not the plugin. */
  welcome: boolean;
  notices: HTMLElement;
  role: Role;
  storage: Storage | undefined;
  help: { open(): void };
  stops: (() => void)[];
}): { wired(client: Pick<WiredClient, "editor" | "views">): void } {
  const { storage } = options;
  let welcomed = false;
  let addHints: (() => void) | undefined;
  const hintsIfWelcomed = () => {
    if (!welcomed || !addHints) return;
    addHints();
    addHints = undefined;
  };
  if (options.welcome) {
    const welcome = createWelcome(options.notices, {
      role: options.role,
      storage,
      onHelp: () => options.help.open(),
      onDone: () => {
        welcomed = true;
        hintsIfWelcomed();
      },
    });
    welcomed = !welcome.shown;
    options.stops.push(() => welcome.close());
  }
  return {
    wired: (client) => {
      if (!options.welcome) return;
      addHints = () =>
        client.editor.view.dispatch({
          effects: StateEffect.appendConfig.of(
            firstHints({
              seen: seenHints(storage),
              remember: (hint) => rememberHint(storage, hint),
              toReading: () => client.views.showReading(),
            }),
          ),
        });
      hintsIfWelcomed();
    },
  };
}
