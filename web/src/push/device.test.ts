// O-40: this device's subscription, in the document: written signed on
// request, its state, removed on request, put right at each opening —
// never another device's entry, even under the same key.
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import {
  type Signer,
  generateIdentityKey,
  readSubscriptions,
  sealSubscription,
  signerOf,
  subscriptionKey,
  verifiedSubscriptions,
  writeSubscription,
} from "../../lib/src/index.js";
import {
  DeviceNotifications,
  type DevicePush,
  type DeviceSubscription,
  PUSH_ENDPOINTS_KEY,
} from "./device.js";

const DOC = "0123456789abcdef0123456789abcdef";
const VAPID_KEY = Uint8Array.of(4, ...new Uint8Array(64).fill(9));
const OTHER_KEY = Uint8Array.of(4, ...new Uint8Array(64).fill(10));
const VAPID = new Uint8Array(32).fill(7);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

class FakeDevice implements DevicePush {
  subscription: DeviceSubscription | undefined;
  refuse = false;
  made = 0;
  async current() {
    return this.subscription;
  }
  async subscribe(vapidKey: Uint8Array) {
    if (this.refuse) throw new Error("denied");
    if (!this.subscription || this.subscription.serverKey !== vapidKey) {
      this.made++;
      this.subscription = {
        endpoint: `https://fcm.googleapis.com/wp/device-${this.made}`,
        p256dh: Uint8Array.of(4, ...new Uint8Array(64).fill(this.made)),
        auth: new Uint8Array(16).fill(this.made),
        serverKey: vapidKey,
      };
    }
    return this.subscription;
  }
}

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

async function setup(signer?: Signer) {
  const key = signer ?? (await signerOf(await generateIdentityKey()));
  const annotationsDoc = new LoroDoc();
  const device = new FakeDevice();
  const storage = memoryStorage();
  const make = (
    doc = annotationsDoc,
    dev: DevicePush = device,
    store = storage,
  ) =>
    new DeviceNotifications({
      annotationsDoc: doc,
      documentId: DOC,
      device: dev,
      vapidKey: VAPID_KEY,
      vapid: VAPID,
      signing: { documentId: DOC, signer: async () => key },
      mine: () => new Set([hex(key.fingerprint)]),
      storage: store,
      now: () => 1000,
    });
  return { key, annotationsDoc, device, storage, make };
}

const endpoints = (doc: LoroDoc) =>
  readSubscriptions(doc)
    .map((s) => s.fields.endpoint)
    .sort();

describe("this device's notifications", () => {
  test("enabled: subscribed, written signed by my key; on; disabled: removed", async () => {
    const t = await setup();
    const control = t.make();
    expect(await control.state()).toBe("off");
    expect(await control.enable()).toBe("on");
    const [entry] = await verifiedSubscriptions(t.annotationsDoc, DOC);
    expect(entry?.fields.endpoint).toBe(t.device.subscription?.endpoint);
    expect(entry && hex(entry.signer.fingerprint)).toBe(hex(t.key.fingerprint));
    expect(entry?.fields.vapid).toEqual(VAPID);
    expect(await control.state()).toBe("on");
    expect(await control.disable()).toBe("off");
    expect(endpoints(t.annotationsDoc)).toEqual([]);
    expect(await control.state()).toBe("off");
  });

  test("without a key, nothing written; refused by the browser, nothing either", async () => {
    const t = await setup();
    const unsigned = new DeviceNotifications({
      annotationsDoc: t.annotationsDoc,
      documentId: DOC,
      device: t.device,
      vapidKey: VAPID_KEY,
      vapid: VAPID,
      signing: { documentId: DOC, signer: async () => undefined },
      mine: () => new Set(),
      storage: t.storage,
      now: () => 1,
    });
    expect(await unsigned.enable()).toBe("no-key");
    t.device.refuse = true;
    t.device.subscription = undefined;
    expect(await t.make().enable()).toBe("refused");
    expect(endpoints(t.annotationsDoc)).toEqual([]);
  });

  test("another device of mine, same key: its entry is neither seen as this one's nor removed", async () => {
    const t = await setup();
    // My phone, elsewhere: its own device, its own storage.
    const phone = new FakeDevice();
    phone.made = 50;
    await t.make(t.annotationsDoc, phone, memoryStorage()).enable();
    const here = t.make();
    expect(await here.state()).toBe("off");
    await here.enable();
    await here.disable();
    expect(endpoints(t.annotationsDoc)).toEqual([
      "https://fcm.googleapis.com/wp/device-51",
    ]);
  });

  test("at the opening, a subscription renewed by the browser replaces its entry", async () => {
    const t = await setup();
    await t.make().enable();
    const before = t.device.subscription?.endpoint as string;
    // The browser renewed it (`pushsubscriptionchange`).
    t.device.made++;
    t.device.subscription = {
      endpoint: "https://fcm.googleapis.com/wp/renewed",
      p256dh: Uint8Array.of(4, ...new Uint8Array(64).fill(3)),
      auth: new Uint8Array(16).fill(3),
      serverKey: VAPID_KEY,
    };
    await t.make().reconcile();
    expect(endpoints(t.annotationsDoc)).toEqual([
      "https://fcm.googleapis.com/wp/renewed",
    ]);
    expect(
      t.annotationsDoc.getMap("subscriptions").get(subscriptionKey(before)),
    ).toBeUndefined();
    expect(await t.make().state()).toBe("on");
  });

  test("at the opening, a subscription under another server key is made again", async () => {
    const t = await setup();
    await t.make().enable();
    t.device.subscription = {
      ...(t.device.subscription as DeviceSubscription),
      serverKey: OTHER_KEY,
    };
    await t.make().reconcile();
    expect(endpoints(t.annotationsDoc)).toEqual([
      t.device.subscription?.endpoint,
    ]);
    expect(t.device.subscription?.serverKey).toBe(VAPID_KEY);
  });

  // Found by device.property.test.ts: the browser renewed its subscription
  // while the page was open, then its user asked again.
  test("enabled again after a renewal: only the new entry stays", async () => {
    const t = await setup();
    const control = t.make();
    await control.enable();
    t.device.subscription = undefined; // renewed: another one next
    expect(await control.enable()).toBe("on");
    expect(endpoints(t.annotationsDoc)).toEqual([
      "https://fcm.googleapis.com/wp/device-2",
    ]);
  });

  test("at the opening, an old entry beside the one in order is removed", async () => {
    const t = await setup();
    // An entry this device wrote before its subscription was renewed…
    const old = {
      endpoint: "https://fcm.googleapis.com/wp/old",
      p256dh: Uint8Array.of(4, ...new Uint8Array(64).fill(5)),
      auth: new Uint8Array(16).fill(5),
      vapid: VAPID,
      createdAt: 1,
    };
    const seal = await sealSubscription(
      { documentId: DOC, signer: async () => t.key },
      subscriptionKey(old.endpoint),
      old,
    );
    if (!seal) throw new Error("not sealed");
    writeSubscription(t.annotationsDoc, old, seal);
    t.storage.setItem(PUSH_ENDPOINTS_KEY, JSON.stringify([old.endpoint]));
    // …and the one of now, beside it (another tab wrote it).
    await t.make().enable();
    const now = t.device.subscription?.endpoint;
    writeSubscription(t.annotationsDoc, old, seal);
    await t.make().reconcile();
    expect(endpoints(t.annotationsDoc)).toEqual([now]);
  });

  test("at the opening, nothing changes for a device that never asked, nor for one in order", async () => {
    const t = await setup();
    await t.make().reconcile();
    expect(endpoints(t.annotationsDoc)).toEqual([]);
    expect(t.device.made).toBe(0);
    await t.make().enable();
    const version = t.annotationsDoc.oplogVersion().toJSON();
    await t.make().reconcile();
    expect(t.annotationsDoc.oplogVersion().toJSON()).toEqual(version);
  });
});
