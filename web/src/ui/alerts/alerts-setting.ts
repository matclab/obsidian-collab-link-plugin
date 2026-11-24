import { flushSync, mount, unmount } from "svelte";
import View from "./AlertsSetting.svelte";
import type { NotificationOffer } from "./notification-offer.js";

/** Mounts the notifications of the document menu (`AlertsSetting.svelte`):
 * the permission as it is now, asked for on a click, its answer shown at
 * once; and this device's, if the server and the browser offer it
 * (ADR-0060 §4), changed on a click. Shown as `offer` changes, whoever
 * changed it (the invitation). */
export function createAlertsSetting(
  container: Element,
  offer: NotificationOffer,
): { close(): void } {
  const view = mount(View, {
    target: container,
    props: {
      onRequest: () => void offer.request(),
      onDevice: (on: boolean) => void offer.setDevice(on),
    },
  });
  const show = () => {
    view.setPermission(offer.permission());
    const device = offer.device();
    // Offered at once; said on once the browser tells.
    view.setDevice(
      device === "pending"
        ? "unsupported"
        : device === "checking"
          ? "off"
          : device,
      offer.attempt(),
    );
    flushSync();
  };
  const stop = offer.subscribe(show);
  show();
  return {
    close() {
      stop();
      void unmount(view);
    },
  };
}
