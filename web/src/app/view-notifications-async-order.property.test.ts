// @vitest-environment jsdom
// A view's notifications under a controlled order (AGENTS.md §1.6; phase
// 38c, NO1 – NO4): what I write, the document opened, the server's key
// read (a key, none, or a failure), its fingerprint computed, who I am
// known, the view closed: each when Hegel says. The notifier, this
// device's control, the alerts and the offer's views are fakes that
// count what is asked of them.
//
// At every step: the device's control settled as the path taken says,
// never left pending once it is decided (NO1); closed, nothing more
// created, the notifier closed with the view (NO2); this device put right
// only once who I am is known, and never closed (NO3); what I write told
// to the invitation always, to the notifier once it exists (NO4).
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test, vi } from "vitest";
import type { Role } from "../../lib/src/index.js";
import { setLanguage } from "../i18n/index.js";
import type { Written } from "../ui/annotations/annotations-panel.js";
import { PageMe } from "../view-model/page-me.js";
import type { OpenedDocument } from "./open-document.js";
import { followNotifications } from "./view-notifications.js";

const seen = vi.hoisted(() => ({
  notifiers: [] as { written: number; closed: number }[],
  devices: [] as { reconciled: number }[],
  /** What each reconcile saw: who I am known, the view closed. */
  reconciles: [] as { known: boolean; closed: boolean }[],
  offers: [] as Promise<unknown>[],
  alerts: { attached: 0, destroyed: 0 },
  invites: [] as { written: number; closed: number }[],
  state: { known: false, closed: false },
}));

vi.mock("../push/notifier.js", () => ({
  Notifier: class {
    private readonly counts = { written: 0, closed: 0 };
    constructor() {
      seen.notifiers.push(this.counts);
    }
    written() {
      this.counts.written += 1;
    }
    close() {
      this.counts.closed += 1;
    }
  },
}));
vi.mock("../push/device.js", () => ({
  DeviceNotifications: class {
    private readonly counts = { reconciled: 0 };
    constructor() {
      seen.devices.push(this.counts);
    }
    async reconcile() {
      this.counts.reconciled += 1;
      seen.reconciles.push({ ...seen.state });
    }
  },
}));
vi.mock("../ui/alerts/notification-offer.js", () => ({
  NotificationOffer: class {
    constructor(_attention: unknown, device: Promise<unknown>) {
      seen.offers.push(device);
    }
    close() {}
  },
}));
vi.mock("../ui/alerts/alerts.js", () => ({
  attachAlerts: () => {
    seen.alerts.attached += 1;
    return {
      destroy: () => {
        seen.alerts.destroyed += 1;
      },
    };
  },
}));
vi.mock("../ui/alerts/alerts-setting.js", () => ({
  createAlertsSetting: () => ({ close: () => {} }),
}));
vi.mock("../ui/alerts/alerts-invite-view.js", () => ({
  createAlertsInvite: () => {
    const counts = { written: 0, closed: 0 };
    seen.invites.push(counts);
    return {
      written: () => {
        counts.written += 1;
      },
      close: () => {
        counts.closed += 1;
      },
    };
  },
}));

type TC = Parameters<Parameters<typeof hegel.testAsync>[0]>[0];

const quiet = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const notificationsScenario = async (tc: TC): Promise<void> => {
  setLanguage("en");
  seen.notifiers.length = 0;
  seen.devices.length = 0;
  seen.reconciles.length = 0;
  seen.offers.length = 0;
  seen.alerts = { attached: 0, destroyed: 0 };
  seen.invites.length = 0;
  seen.state = { known: false, closed: false };
  const root = document.createElement("div");

  // Weighted toward the paths that wait: Web Push, with this device.
  const role = tc.draw(
    gs.sampledFrom(["edit", "edit", "suggest", "read"] as Role[]),
  );
  const often = () => tc.draw(gs.integers({ minValue: 0, maxValue: 3 })) > 0;
  const withAttention = tc.draw(gs.booleans());
  const withDevice = often();
  const withPushKey = often();
  const keyRead = deferred<Uint8Array | undefined>();
  // Its failure is the view's to catch, once open; never open, nobody's.
  keyRead.promise.catch(() => {});
  const fingerprint = deferred<ArrayBuffer>();
  const keysKnown = deferred<void>();
  const digest = vi
    .spyOn(crypto.subtle, "digest")
    .mockImplementation(() => fingerprint.promise);

  const stops: (() => void)[] = [];
  let closed = false;
  const notifications = followNotifications({
    root,
    role,
    env: {
      ...(withAttention && {
        attention: {} as never,
      }),
      ...(withDevice && { devicePush: {} as never }),
      ...(withPushKey && { pushKey: () => keyRead.promise }),
    },
    apiBase: "https://collab.test",
    documentId: "doc",
    storage: undefined,
    me: new PageMe(""),
    signing: undefined,
    roleSecret: () => "secret",
    title: () => undefined,
    name: () => "Ada",
    keysKnown: keysKnown.promise,
    say: () => {},
    stops,
    closed: () => closed,
  });
  // As the view: the menu built at once, its section given if offered.
  const offers =
    (role !== "read" && withAttention) ||
    (role !== "read" && withDevice && withPushKey);
  expect(notifications.offers).toBe(offers);
  if (notifications.offers) {
    notifications.show(document.createElement("section"));
  }
  type Settled = "no" | "control" | "none";
  let settled = "no" as Settled;
  void seen.offers[0]?.then((control) => {
    settled = control ? "control" : "none";
  });

  const ready = {
    client: { show: () => {} },
    annotationsDoc: {},
    connection: { acknowledged: () => 0 },
    onAcked: () => () => {},
  } as unknown as Pick<
    OpenedDocument,
    "client" | "annotationsDoc" | "connection" | "onAcked"
  >;
  const pushPath = role !== "read" && withPushKey;
  let opened = false;
  let key: "no" | "key" | "none" | "fail" = "no";
  let closedAtKey = false;
  let fingerprinted = false;
  /** Closed as the fingerprint came, after it was asked for: computed
   * before, it is read as soon as asked. */
  let closedAtFingerprint = false;
  let askedSoFar = false;
  let writes = 0;
  let writesToNotifier = 0;
  let createdAtClose: { notifiers: number; devices: number } | undefined;

  const moves = [
    "write",
    "open",
    "key",
    "fingerprint",
    "known",
    "close",
  ] as const;
  // As the view: opened at once, unless drawn later or closed before.
  if (tc.draw(gs.booleans())) {
    opened = true;
    notifications.opened(ready);
  }
  const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 20 }));
  for (let step = 0; step < steps; step++) {
    const move = tc.draw(gs.sampledFrom([...moves]));
    switch (move) {
      case "write":
        writes += 1;
        if (seen.notifiers.length > 0) writesToNotifier += 1;
        notifications.written({} as Written);
        break;
      case "open":
        if (opened || closed) break;
        opened = true;
        notifications.opened(ready);
        break;
      case "key": {
        if (key !== "no") break;
        key = tc.draw(gs.sampledFrom(["key", "key", "none", "fail"] as const));
        closedAtKey = closed;
        if (key === "fail") keyRead.reject(new Error("offline"));
        else keyRead.resolve(key === "key" ? new Uint8Array([1]) : undefined);
        break;
      }
      case "fingerprint":
        if (fingerprinted) break;
        fingerprinted = true;
        closedAtFingerprint = closed && askedSoFar;
        fingerprint.resolve(new Uint8Array(32).buffer);
        break;
      case "known":
        seen.state.known = true;
        keysKnown.resolve();
        break;
      case "close":
        if (closed) break;
        closed = true;
        seen.state.closed = true;
        for (const stop of stops.splice(0)) stop();
        createdAtClose = {
          notifiers: seen.notifiers.length,
          devices: seen.devices.length,
        };
        break;
    }
    await quiet();

    // The fingerprint asked only once the key is read.
    const asked = opened && pushPath && key === "key" && !closedAtKey;
    expect(digest).toHaveBeenCalledTimes(asked ? 1 : 0);
    askedSoFar = asked;
    const made = asked && fingerprinted && !closedAtFingerprint;
    // NO1: settled as the path taken says, once it is decided.
    let expected: Settled = "no";
    if (opened && !pushPath) expected = "none";
    else if (opened && key !== "no" && !asked) expected = "none";
    else if (asked && fingerprinted) {
      expected = made && withDevice ? "control" : "none";
    }
    if (offers) expect(settled).toBe(expected);
    // NO2: created only while open; closed with the view.
    expect(seen.notifiers.length).toBe(made ? 1 : 0);
    expect(seen.devices.length).toBe(made && withDevice ? 1 : 0);
    if (createdAtClose) {
      expect(seen.notifiers.length).toBe(createdAtClose.notifiers);
      expect(seen.devices.length).toBe(createdAtClose.devices);
      for (const notifier of seen.notifiers) expect(notifier.closed).toBe(1);
      expect(seen.alerts.destroyed).toBe(seen.alerts.attached);
    }
    // NO3: put right once who I am is known, never closed, once.
    for (const reconcile of seen.reconciles) {
      expect(reconcile).toEqual({ known: true, closed: false });
    }
    expect(seen.reconciles.length).toBeLessThanOrEqual(1);
    // NO4: the invitation told of everything, the notifier from its
    // creation on.
    if (offers) expect(seen.invites[0]?.written).toBe(writes);
    expect(seen.notifiers[0]?.written ?? 0).toBe(writesToNotifier);
    // The alerts, for who can reply, once open.
    expect(seen.alerts.attached).toBe(
      opened && withAttention && role !== "read" ? 1 : 0,
    );
  }
};

describe("a view's notifications under a controlled order", () => {
  test(
    "NO1 – NO4 at every step, whatever the order",
    () =>
      hegel.testAsync(
        async (tc) => {
          // The fingerprint's spy restored even when a case fails: the
          // next one draws again from a clean slate.
          try {
            await notificationsScenario(tc);
          } finally {
            vi.restoreAllMocks();
          }
        },
        { testCases: 400 },
      ),
    600_000,
  );
});
