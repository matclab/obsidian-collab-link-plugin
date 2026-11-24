import { flushSync, mount, unmount } from "svelte";
import { t } from "../../i18n/index.js";
import View from "./AlertsInvite.svelte";
import {
  type InviteOffer,
  answeredInvites,
  inviteOffer,
  rememberInvite,
} from "./alerts-invite.js";
import type { NotificationOffer } from "./notification-offer.js";

/** Mounts the invitation to be notified (`AlertsInvite.svelte`, NI1 – NI5):
 * shown once `written` is told and `offer` has something
 * left; answered by a button, its dismissal, or a change of `offer` while
 * shown (the menu's, NI4), remembered for the document. Closed unanswered,
 * nothing remembered. */
export function createAlertsInvite(
  container: Element,
  options: {
    offer: NotificationOffer;
    documentId: string;
    storage: Storage | undefined;
    /** Says what the browser answered, when it refused. */
    say(text: string): void;
  },
): { written(): void; close(): void } {
  const { offer, documentId, storage } = options;
  let written = false;
  let shown: InviteOffer | undefined;
  let done = false;
  const show = (next: InviteOffer | undefined) => {
    shown = next;
    view.setOffer(next);
    flushSync();
  };
  const answer = () => {
    done = true;
    rememberInvite(storage, documentId);
    show(undefined);
  };
  const view = mount(View, {
    target: container,
    props: {
      onBrowser: () => {
        answer();
        void offer.request();
      },
      onDevice: () => {
        answer();
        void offer.setDevice(true).then(() => {
          const now = offer.attempt();
          if (now === "refused") options.say(t().pushRefused);
          else if (now === "no-key") options.say(t().pushNeedsKey);
        });
      },
      onLater: answer,
    },
  });
  const update = () => {
    if (done || shown) return;
    const next = inviteOffer({
      documentId,
      written,
      permission: offer.permission(),
      device: offer.device(),
      attempt: offer.attempt(),
      answered: answeredInvites(storage),
    });
    if (next) show(next);
  };
  // Shown, `offer` changes only by the menu: an answer too.
  const stop = offer.subscribe(() => (shown ? answer() : update()));
  return {
    written() {
      written = true;
      update();
    },
    close() {
      done = true;
      stop();
      void unmount(view);
    },
  };
}
