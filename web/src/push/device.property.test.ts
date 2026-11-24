// This device's entry under a controlled order (AGENTS.md §1.6; O-40;
// phase 34, analysis 34 bis, NP4 and NX9 – NX12): two tabs of one browser,
// each with its own copy of the document, synchronised when Hegel says;
// the user's gestures (enable, disable) in either; a tab reloaded at any
// moment (a new copy, the old one's work never reaching the document);
// the browser's subscription renewed (`pushsubscriptionchange`), the
// server's key changed (its base lost). Every call to the browser and
// every signature, made or checked, ends when Hegel says (one gate).
//
// At every step, in every copy (NP4): each entry is whole, its signature
// checks (two tabs writing the same endpoint never leave a mix); the entry
// of my other device, and another's, are never removed. Once quiet, all
// synchronised, and a tab opened: this browser has at most one entry, its
// subscription of now under the server's key of now — and one if it had
// any before.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc } from "loro-crdt";
import { describe, expect, test, vi } from "vitest";
import {
  type Signer,
  type SubscriptionFields,
  generateIdentityKey,
  readSubscriptions,
  sealSubscription,
  signerOf,
  subscriptionKey,
  verifiedSubscriptions,
  writeSubscription,
} from "../../lib/src/index.js";
import type { CryptoGate } from "../../lib/src/transport/test-support/crypto-gate.js";
import {
  DeviceNotifications,
  type DevicePush,
  type DeviceSubscription,
} from "./device.js";

const shared = vi.hoisted(() => ({ gate: undefined as unknown, open: false }));

vi.mock("../../lib/src/identity/keys.js", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../../lib/src/identity/keys.js")>();
  const { CryptoGate } = await import(
    "../../lib/src/transport/test-support/crypto-gate.js"
  );
  const gate = new CryptoGate();
  shared.gate = gate;
  const verify = gate.wrap("verify", real.verifyBytes);
  const sign = gate.wrap("sign", real.signBytes);
  // The test's own writes and checks go round the gate.
  return {
    ...real,
    verifyBytes: (...args: Parameters<typeof real.verifyBytes>) =>
      shared.open ? real.verifyBytes(...args) : verify(...args),
    signBytes: (...args: Parameters<typeof real.signBytes>) =>
      shared.open ? real.signBytes(...args) : sign(...args),
  };
});

const DOC = "0123456789abcdef0123456789abcdef";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const sameBytes = (a: Uint8Array | undefined, b: Uint8Array) =>
  a !== undefined && hex(a) === hex(b);

/** The server's key, and its fingerprint, by generation (NX11). */
const serverKey = (n: number) => ({
  vapidKey: Uint8Array.of(4, ...new Uint8Array(64).fill(20 + n)),
  vapid: new Uint8Array(32).fill(20 + n),
});

const people = (async () => ({
  me: await signerOf(await generateIdentityKey()),
  bob: await signerOf(await generateIdentityKey()),
}))();

type TC = Parameters<Parameters<typeof hegel.testAsync>[0]>[0];

/** The browser both tabs share: one subscription, made and renewed by it. */
class Browser {
  subscription: DeviceSubscription | undefined;
  made = 0;
  make(vapidKey: Uint8Array): DeviceSubscription {
    this.made++;
    this.subscription = {
      endpoint: `https://fcm.googleapis.com/wp/browser-${this.made}`,
      p256dh: Uint8Array.of(4, ...new Uint8Array(64).fill(this.made)),
      auth: new Uint8Array(16).fill(this.made),
      serverKey: vapidKey,
    };
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

async function writeEntry(doc: LoroDoc, by: Signer, endpoint: string) {
  const fields: SubscriptionFields = {
    endpoint,
    p256dh: Uint8Array.of(4, ...new Uint8Array(64).fill(99)),
    auth: new Uint8Array(16).fill(99),
    vapid: serverKey(0).vapid,
    createdAt: 1,
  };
  const seal = await sealSubscription(
    { documentId: DOC, signer: async () => by },
    subscriptionKey(endpoint),
    fields,
  );
  if (!seal) throw new Error("not sealed");
  writeSubscription(doc, fields, seal);
}

const PHONE = "https://fcm.googleapis.com/wp/my-phone";
const BOB = "https://fcm.googleapis.com/wp/bob";

const scenario = async (tc: TC): Promise<void> => {
  const gate = shared.gate as CryptoGate;
  const p = await people;
  const base = new LoroDoc();
  // My phone (same key, its own browser) and Bob have entries already.
  await writeEntry(base, p.me, PHONE);
  await writeEntry(base, p.bob, BOB);
  const browser = new Browser();
  const storage = memoryStorage(); // the browser's, both tabs'
  let generation = 0; // of the server's key
  let clock = 0;
  const failures: string[] = [];

  /** The browser's Push API, each answer when Hegel says. */
  const device: DevicePush = {
    current: gate.wrap("current", async () => browser.subscription),
    subscribe: gate.wrap("subscribe", async (vapidKey: Uint8Array) =>
      browser.subscription &&
      sameBytes(browser.subscription.serverKey, vapidKey)
        ? browser.subscription
        : browser.make(vapidKey),
    ),
  };

  interface Tab {
    doc: LoroDoc;
    control: DeviceNotifications;
  }
  const open = (from: LoroDoc): Tab => {
    const doc = LoroDoc.fromSnapshot(from.export({ mode: "snapshot" }));
    const { vapidKey, vapid } = serverKey(generation);
    const control = new DeviceNotifications({
      annotationsDoc: doc,
      documentId: DOC,
      device,
      vapidKey,
      vapid,
      signing: { documentId: DOC, signer: async () => p.me },
      mine: () => new Set([hex(p.me.fingerprint)]),
      storage,
      now: () => ++clock, // two tabs never write the same fields
    });
    return { doc, control };
  };
  /** A gesture or an opening: its failure noted, raised by the test. */
  const run = (work: Promise<unknown>) =>
    void work.catch((error) => failures.push(String(error)));
  const reload = (tab: Tab): Tab => {
    // The old copy is dropped: what its page still does reaches nothing.
    const fresh = open(tab.doc);
    run(fresh.control.reconcile());
    return fresh;
  };
  const sync = (a: LoroDoc, b: LoroDoc) => {
    a.import(b.export({ mode: "update", from: a.oplogVersion() }));
    b.import(a.export({ mode: "update", from: b.oplogVersion() }));
  };

  const quiet = async () => {
    for (let round = 0; round < 1000; round++) {
      for (let i = 0; i < 10_000 && gate.running > 0; i++) {
        await new Promise((r) => setTimeout(r, 0));
      }
      if (gate.running > 0) throw new Error("something hangs");
      // A macrotask: every chain of microtasks has reached the gate, or
      // its end (an opening runs through more than a few).
      await new Promise((r) => setTimeout(r, 0));
      if (gate.running === 0) return;
    }
    throw new Error("something keeps starting");
  };

  const mine = (doc: LoroDoc) =>
    readSubscriptions(doc)
      .map((e) => e.fields.endpoint)
      .filter((e) => e.startsWith("https://fcm.googleapis.com/wp/browser-"));
  /** NP4, in a copy. */
  const check = async (doc: LoroDoc, at: string) => {
    if (failures.length > 0) throw new Error(failures.join("; "));
    shared.open = true;
    try {
      const entries = doc.getMap("subscriptions").size;
      const read = readSubscriptions(doc).length;
      const verified = (await verifiedSubscriptions(doc, DOC)).length;
      expect(verified, `${at}: an entry not whole`).toBe(entries);
      expect(read, `${at}: an entry not well formed`).toBe(entries);
    } finally {
      shared.open = false;
    }
    const endpoints = readSubscriptions(doc).map((e) => e.fields.endpoint);
    expect(endpoints, `${at}: another device's entry removed`).toContain(PHONE);
    expect(endpoints, `${at}: another's entry removed`).toContain(BOB);
  };

  gate.start();
  try {
    const tabs: [Tab, Tab] = [open(base), open(base)];
    const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 16 }));
    for (let step = 0; step < steps; step++) {
      const t = tc.draw(gs.integers({ minValue: 0, maxValue: 1 }));
      const tab = tabs[t] as Tab;
      switch (tc.draw(gs.integers({ minValue: 0, maxValue: 7 }))) {
        case 0:
        case 1:
          run(tab.control.enable());
          break;
        case 2:
          run(tab.control.disable());
          break;
        case 3:
          tabs[t] = reload(tab);
          break;
        case 4:
          sync(tabs[0].doc, tabs[1].doc);
          break;
        case 5:
          // The browser renewed its subscription (NX12).
          if (browser.subscription) {
            browser.make(browser.subscription.serverKey as Uint8Array);
          }
          break;
        case 6:
          // The server lost its base (NX11): tabs opened from now on
          // read another key.
          if (tc.draw(gs.integers({ minValue: 0, maxValue: 3 })) === 0) {
            generation++;
          }
          break;
        default:
          if (gate.held.length === 0) break;
          gate.release(
            gate.held[
              tc.draw(
                gs.integers({ minValue: 0, maxValue: gate.held.length - 1 }),
              )
            ] as never,
          );
      }
      await quiet();
      await check(tabs[0].doc, `step ${step}, tab 0`);
      await check(tabs[1].doc, `step ${step}, tab 1`);
    }
    // Everything ends, in an order Hegel draws; then all is synchronised.
    const drain = async () => {
      while (gate.held.length > 0) {
        gate.release(
          gate.held[
            tc.draw(
              gs.integers({ minValue: 0, maxValue: gate.held.length - 1 }),
            )
          ] as never,
        );
        await quiet();
      }
    };
    await drain();
    sync(tabs[0].doc, tabs[1].doc);
    await check(tabs[0].doc, "synchronised");
    const before = mine(tabs[0].doc).length;
    // A tab opened (O-40): the entry put right.
    const last = reload(tabs[0]);
    await quiet();
    await drain();
    await check(last.doc, "opened");
    const current = browser.subscription;
    const { vapidKey } = serverKey(generation);
    if (before === 0) {
      expect(mine(last.doc), "an entry nobody asked for").toEqual([]);
    } else {
      expect(current && sameBytes(current.serverKey, vapidKey)).toBe(true);
      expect(mine(last.doc), "not this browser's subscription").toEqual([
        current?.endpoint,
      ]);
    }
  } finally {
    // A case that failed half way: its work ends before the next starts,
    // which would otherwise count it as its own.
    for (let i = 0; i < 1000 && gate.held.length > 0; i++) {
      gate.release(gate.held[0] as never);
      await quiet().catch(() => undefined);
    }
    gate.stop();
  }
};

describe("this device's entry, under a controlled order", () => {
  test(
    "NP4 at every step; once opened, the browser's subscription of now",
    () => hegel.testAsync(scenario, { testCases: 200 }),
    120_000,
  );
});
