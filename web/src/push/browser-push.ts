/** This browser's push (the Push API), for `DevicePush`: built by
 * `main.ts`, through the page's service worker, which the browser wakes
 * when a message comes (ADR-0030, ADR-0060 §3). */
import type { DevicePush, DeviceSubscription } from "./device.js";

/** What of the Push API this uses: a registration's `pushManager`. */
interface Manager {
  getSubscription(): Promise<PushSubscription | null>;
  subscribe(options: {
    userVisibleOnly: boolean;
    applicationServerKey: BufferSource;
  }): Promise<PushSubscription>;
}

function bytesOf(
  buffer: ArrayBuffer | null | undefined,
): Uint8Array | undefined {
  return buffer ? new Uint8Array(buffer) : undefined;
}

function read(subscription: PushSubscription): DeviceSubscription | undefined {
  const p256dh = bytesOf(subscription.getKey("p256dh"));
  const auth = bytesOf(subscription.getKey("auth"));
  if (!p256dh || !auth) return undefined;
  const key = subscription.options.applicationServerKey;
  return {
    endpoint: subscription.endpoint,
    p256dh,
    auth,
    serverKey: key ? new Uint8Array(key) : undefined,
  };
}

const sameBytes = (a: Uint8Array | undefined, b: Uint8Array) =>
  a !== undefined && a.length === b.length && a.every((x, i) => x === b[i]);

/** `undefined` where there is no push: no service worker, no
 * `PushManager` (an old browser, a page not installed on iOS). */
export function browserDevicePush(
  container: { ready: Promise<{ pushManager?: Manager }> } | undefined,
  hasPushManager: boolean,
): DevicePush | undefined {
  if (!container || !hasPushManager) return undefined;
  const manager = async () => {
    const registration = await container.ready;
    if (!registration.pushManager) throw new Error("no push here");
    return registration.pushManager;
  };
  return {
    async current() {
      const subscription = await (await manager()).getSubscription();
      return subscription ? read(subscription) : undefined;
    },
    async subscribe(vapidKey) {
      const pushManager = await manager();
      const held = await pushManager.getSubscription();
      if (held) {
        const kept = read(held);
        if (kept && sameBytes(kept.serverKey, vapidKey)) return kept;
        // Made with another key (the server's database lost, W-65): a
        // browser holds one subscription per worker.
        await held.unsubscribe();
      }
      const made = read(
        await pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: vapidKey as BufferSource,
        }),
      );
      if (!made) throw new Error("a subscription without its keys");
      return made;
    },
  };
}
