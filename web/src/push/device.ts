/** Notifying this device even with the page closed (ADR-0060 §4, O-40):
 * its browser's subscription, written signed in the document on its
 * user's request, put right at each opening, removed on request. The
 * device remembers the endpoints it wrote (`storage`), to know its own
 * entries among those its other devices signed with the same key. */
import type { LoroDoc } from "loro-crdt";
import {
  type DocumentSigning,
  removeSubscription,
  sealSubscription,
  subscriptionKey,
  verifiedSubscriptions,
  writeSubscription,
} from "../../lib/src/index.js";

/** A subscription of this browser (the Push API). */
export interface DeviceSubscription {
  endpoint: string;
  p256dh: Uint8Array;
  auth: Uint8Array;
  /** The key it was made with (`options.applicationServerKey`). */
  serverKey: Uint8Array | undefined;
}

/** This browser's push: `main.ts` builds it from the service worker's
 * `pushManager`; without one (the plugin, an old browser), none. */
export interface DevicePush {
  current(): Promise<DeviceSubscription | undefined>;
  /** Subscribes with `vapidKey`, asking the permission if need be; one
   * made with another key is replaced. Rejects if refused. */
  subscribe(vapidKey: Uint8Array): Promise<DeviceSubscription>;
}

/** Where this device keeps the endpoints it wrote. */
export const PUSH_ENDPOINTS_KEY = "obsidian-collab:push-endpoints";
const REMEMBERED = 8;

/** This device in this document: notified there, or not. */
export type DeviceNotificationState = "on" | "off";

/** What subscribing gave: on, or why not — this device as it was. */
export type DeviceEnableOutcome =
  | "on"
  /** No key to sign the entry: an unsigned one is never used (D-42). */
  | "no-key"
  /** The browser refused (the permission, or its push service). */
  | "refused";

export interface DeviceNotificationOptions {
  annotationsDoc: LoroDoc;
  documentId: string;
  device: DevicePush;
  /** The server's VAPID public key (`/config.json`, W-65). */
  vapidKey: Uint8Array;
  /** Its fingerprint. */
  vapid: Uint8Array;
  signing: DocumentSigning | undefined;
  /** My keys' fingerprints, in hexadecimal. */
  mine(): ReadonlySet<string>;
  storage: Pick<Storage, "getItem" | "setItem"> | undefined;
  now(): number;
}

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const sameBytes = (a: Uint8Array | undefined, b: Uint8Array) =>
  a !== undefined && a.length === b.length && a.every((x, i) => x === b[i]);

export class DeviceNotifications {
  constructor(private readonly options: DeviceNotificationOptions) {}

  private remembered(): string[] {
    try {
      const list: unknown = JSON.parse(
        this.options.storage?.getItem(PUSH_ENDPOINTS_KEY) ?? "[]",
      );
      return Array.isArray(list)
        ? list.filter((e): e is string => typeof e === "string")
        : [];
    } catch {
      return [];
    }
  }

  private remember(endpoint: string): void {
    const list = [endpoint, ...this.remembered().filter((e) => e !== endpoint)];
    try {
      this.options.storage?.setItem(
        PUSH_ENDPOINTS_KEY,
        JSON.stringify(list.slice(0, REMEMBERED)),
      );
    } catch {
      // Storage refused: the next opening can't tell its old entries.
    }
  }

  /** This device's entries in the document: an endpoint it wrote, signed
   * by one of my keys. */
  private async mine(): Promise<Set<string>> {
    const { annotationsDoc, documentId } = this.options;
    const remembered = new Set(this.remembered());
    const mineKeys = this.options.mine();
    const entries = await verifiedSubscriptions(annotationsDoc, documentId);
    return new Set(
      entries
        .filter(
          (e) =>
            remembered.has(e.fields.endpoint) &&
            mineKeys.has(toHex(e.signer.fingerprint)),
        )
        .map((e) => e.fields.endpoint),
    );
  }

  /** The browser's subscription, if made with the server's key of now. */
  private async usable(): Promise<DeviceSubscription | undefined> {
    const current = await this.options.device.current();
    return current && sameBytes(current.serverKey, this.options.vapidKey)
      ? current
      : undefined;
  }

  async state(): Promise<DeviceNotificationState> {
    const current = await this.usable();
    if (!current) return "off";
    return (await this.mine()).has(current.endpoint) ? "on" : "off";
  }

  /** On its user's request: subscribes, then writes the entry, signed. */
  async enable(): Promise<DeviceEnableOutcome> {
    let subscription: DeviceSubscription;
    try {
      subscription = await this.options.device.subscribe(this.options.vapidKey);
    } catch {
      return "refused";
    }
    return this.write(subscription);
  }

  /** Writes the entry of `subscription`, and deletes this device's
   * others (O-40): a subscription renewed by the browser leaves none. */
  private async write(
    subscription: DeviceSubscription,
  ): Promise<DeviceEnableOutcome> {
    const { annotationsDoc, signing } = this.options;
    const others = await this.mine();
    const fields = {
      endpoint: subscription.endpoint,
      p256dh: subscription.p256dh,
      auth: subscription.auth,
      vapid: this.options.vapid,
      createdAt: this.options.now(),
    };
    const seal = await sealSubscription(
      signing,
      subscriptionKey(fields.endpoint),
      fields,
    );
    if (!seal) return "no-key";
    this.remember(fields.endpoint);
    writeSubscription(annotationsDoc, fields, seal);
    this.remove(others, fields.endpoint);
    return "on";
  }

  /** On its user's request: deletes this device's entries. The browser's
   * subscription stays: other documents may use it. */
  async disable(): Promise<"off"> {
    this.remove(await this.mine());
    return "off";
  }

  private remove(endpoints: Set<string>, except?: string): void {
    for (const endpoint of endpoints) {
      if (endpoint === except) continue;
      removeSubscription(
        this.options.annotationsDoc,
        subscriptionKey(endpoint),
      );
    }
  }

  /** At the opening (O-40): an entry of this device's that the browser no
   * longer holds, or holds under another key, is deleted, and its new
   * subscription written — the user asked to be notified here. */
  async reconcile(): Promise<void> {
    const entries = await this.mine();
    if (entries.size === 0) return;
    const current = await this.usable();
    if (current && entries.has(current.endpoint)) {
      this.remove(entries, current.endpoint);
      return;
    }
    this.remove(entries);
    let renewed = current;
    if (!renewed) {
      try {
        renewed = await this.options.device.subscribe(this.options.vapidKey);
      } catch {
        return; // refused since: nothing written
      }
    }
    await this.write(renewed);
  }
}
