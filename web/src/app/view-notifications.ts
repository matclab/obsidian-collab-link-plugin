import {
  type DocumentSigning,
  type Role,
  postNotification,
} from "../../lib/src/index.js";
import { DeviceNotifications } from "../push/device.js";
import { Notifier } from "../push/notifier.js";
import { createAlertsInvite } from "../ui/alerts/alerts-invite-view.js";
import { createAlertsSetting } from "../ui/alerts/alerts-setting.js";
import { attachAlerts } from "../ui/alerts/alerts.js";
import { NotificationOffer } from "../ui/alerts/notification-offer.js";
import type { Written } from "../ui/annotations/annotations-panel.js";
import type { PageMe } from "../view-model/page-me.js";
import type { DocumentViewEnvironment } from "./document-view.js";
import type { OpenedDocument } from "./open-document.js";

/** The notifications of a document view (ADR-0060), for who can reply:
 * the offer, in the menu and the invitation; once open, the
 * alerts in this window (§1) and Web Push (§3 – §5). Its interleavings:
 * NO1 – NO4 (`docs/phase-38-refactorisation-de-la-page.md`). */
export interface ViewNotifications {
  /** Whether anything is offered: the menu then has its section. */
  readonly offers: boolean;
  /** The menu's section and the invitation, once the menu is built. */
  show(section: HTMLElement): void;
  /** What I write (§5; NI1). */
  written(written: Written): void;
  /** The document open: the alerts, and Web Push if the server posts. */
  opened(
    ready: Pick<
      OpenedDocument,
      "client" | "annotationsDoc" | "connection" | "onAcked"
    >,
  ): void;
}

export function followNotifications(options: {
  root: HTMLElement;
  role: Role;
  env: Pick<
    DocumentViewEnvironment,
    "attention" | "devicePush" | "pushKey" | "fetch"
  >;
  apiBase: string;
  documentId: string;
  storage: Storage | undefined;
  me: PageMe;
  signing: DocumentSigning | undefined;
  /** The role's secret, as a header, under the secret of now. */
  roleSecret(): string;
  title(): string | undefined;
  name(): string;
  /** Resolved once who I am is known (NV7). */
  keysKnown: Promise<void>;
  say(text: string): void;
  /** The view's, run as it closes; and whether it has. */
  stops: (() => void)[];
  closed(): boolean;
}): ViewNotifications {
  const { role, env, documentId: docId, me, signing, storage, stops } = options;
  // The notifications (ADR-0060 §1): for who can reply. This device, page
  // closed (§4): once the document is open and the server's key known.
  const attention = role === "read" ? undefined : env.attention;
  let settleDevice: (control: DeviceNotifications | undefined) => void =
    () => {};
  const deviceControl = new Promise<DeviceNotifications | undefined>(
    (resolve) => {
      settleDevice = resolve;
    },
  );
  // Shared by the menu and the invitation (NI4).
  const offered =
    attention || (role !== "read" && env.devicePush && env.pushKey)
      ? new NotificationOffer(attention, deviceControl)
      : undefined;
  /** Told of what I write (NI1). */
  let invite: { written(): void } | undefined;
  /** Notifies what I write (ADR-0060 §5), once the server's key is known. */
  let notifier: Notifier | undefined;
  return {
    offers: offered !== undefined,
    show: (section) => {
      if (!offered) return;
      const alertsSetting = createAlertsSetting(section, offered);
      // Last in the view, held at its bottom: seen wherever I wrote (NI4).
      const inviteBox = document.createElement("div");
      inviteBox.className = "view-invite";
      options.root.append(inviteBox);
      const created = createAlertsInvite(inviteBox, {
        offer: offered,
        documentId: docId,
        storage,
        say: (text) => options.say(text),
      });
      invite = created;
      stops.push(() => {
        created.close();
        alertsSetting.close();
        offered.close();
      });
    },
    written: (written) => {
      notifier?.written(written);
      invite?.written();
    },
    opened: (ready) => {
      // The alerts (ADR-0060 §1): once the history is in and who I am
      // known.
      if (attention) {
        const alerts = attachAlerts({
          documentId: docId,
          awaiting: ready.client.awaiting,
          index: ready.client.index,
          signatures: ready.client.signatures,
          attention,
          title: options.title,
          opened: options.keysKnown,
          show: (id) => ready.client.show(id),
        });
        stops.push(() => alerts.destroy());
      }
      // Web Push (ADR-0060 §3 – §5): my replies and rejections notify
      // their recipients, and this device may be notified, if the server
      // posts.
      if (role !== "read" && env.pushKey) {
        void env
          .pushKey(options.apiBase)
          .then(async (vapidKey) => {
            if (!vapidKey || options.closed()) return settleDevice(undefined);
            const vapid = new Uint8Array(
              await crypto.subtle.digest("SHA-256", vapidKey as BufferSource),
            );
            if (options.closed()) return settleDevice(undefined);
            notifier = new Notifier({
              annotationsDoc: ready.annotationsDoc,
              documentId: docId,
              acknowledged: (peer) =>
                ready.connection.acknowledged("annotations", peer),
              onAcked: (told) => ready.onAcked(told),
              decisions: ready.client.decisions,
              mine: () => me.current().keys,
              vapid,
              title: () => options.title() ?? "",
              name: options.name,
              post: (request) =>
                postNotification(
                  options.apiBase,
                  docId,
                  options.roleSecret(),
                  request,
                  env.fetch ?? (() => Promise.reject(new Error("offline"))),
                ),
            });
            stops.push(() => notifier?.close());
            if (!env.devicePush) return settleDevice(undefined);
            const control = new DeviceNotifications({
              annotationsDoc: ready.annotationsDoc,
              documentId: docId,
              device: env.devicePush,
              vapidKey,
              vapid,
              signing,
              mine: () => me.current().keys,
              storage,
              now: () => Date.now(),
            });
            settleDevice(control);
            // O-40: put right once who I am is known.
            await options.keysKnown;
            if (!options.closed()) await control.reconcile();
          })
          .catch(() => settleDevice(undefined));
      } else settleDevice(undefined);
    },
  };
}
