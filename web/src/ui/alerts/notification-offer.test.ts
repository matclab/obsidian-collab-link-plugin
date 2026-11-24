// The notifications offered to a view (ADR-0060 §1, §4; phase 34j, NI4):
// one state, this device apart from the outcome of the last gesture on
// it, shared by the document menu and the invitation, each told of
// what the other changes.
import { describe, expect, test } from "vitest";
import type { DeviceNotificationState } from "../../push/device.js";
import type { AlertPermission } from "./alerts.js";
import { NotificationOffer } from "./notification-offer.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function browser(start: AlertPermission, answer: AlertPermission) {
  let now = start;
  return {
    permission: () => now,
    request: async () => {
      now = answer;
      return answer;
    },
    grant: () => {
      now = "granted";
    },
  };
}

function device(start: DeviceNotificationState, onEnable = () => {}) {
  let now = start;
  return {
    state: async () => now,
    enable: async () => {
      onEnable();
      now = "on";
      return now;
    },
    disable: async () => {
      now = "off";
      return now;
    },
  };
}

describe("the notifications offered to a view", () => {
  test("this device pending, then checked, then its state", async () => {
    let resolve: (d: unknown) => void = () => {};
    const found = new Promise((r) => {
      resolve = r;
    });
    const offer = new NotificationOffer(undefined, found as never);
    expect(offer.device()).toBe("pending");
    expect(offer.permission()).toBe("unsupported");
    resolve(device("on"));
    await settle();
    expect(offer.device()).toBe("on");
  });

  test("no device: unsupported", async () => {
    expect(new NotificationOffer(undefined, undefined).device()).toBe(
      "unsupported",
    );
    const offer = new NotificationOffer(undefined, Promise.resolve(undefined));
    await settle();
    expect(offer.device()).toBe("unsupported");
  });

  test("a device whose state fails: off", async () => {
    const offer = new NotificationOffer(
      undefined,
      Promise.resolve({
        state: () => Promise.reject(new Error("no")),
      } as never),
    );
    await settle();
    expect(offer.device()).toBe("off");
  });

  test("the permission asked: each listener told", async () => {
    const offer = new NotificationOffer(
      browser("default", "granted"),
      undefined,
    );
    const told: string[] = [];
    offer.subscribe(() => told.push("a"));
    offer.subscribe(() => told.push("b"));
    await offer.request();
    expect(offer.permission()).toBe("granted");
    expect(told).toEqual(["a", "b"]);
  });

  test("this device enabled: busy, then on, the permission read again", async () => {
    const page = browser("default", "granted");
    const offer = new NotificationOffer(
      page,
      Promise.resolve(device("off", () => page.grant()) as never),
    );
    await settle();
    const seen: string[] = [];
    offer.subscribe(() =>
      seen.push(`${offer.device()} ${offer.attempt()} ${offer.permission()}`),
    );
    const done = offer.setDevice(true);
    expect([offer.device(), offer.attempt()]).toEqual(["off", "busy"]);
    await done;
    expect(seen).toEqual(["off busy default", "on idle granted"]);
    await offer.setDevice(false);
    expect(offer.device()).toBe("off");
  });

  // Its subscription refused (the push service's), this device keeps the
  // entry it had: said as it is, the refusal apart (found 2026-11-20).
  test("a subscription refused or unsigned: this device as it was, the outcome apart", async () => {
    for (const before of ["on", "off"] as const) {
      for (const outcome of ["refused", "no-key"] as const) {
        const offer = new NotificationOffer(
          undefined,
          Promise.resolve({
            state: async () => before,
            enable: async () => outcome,
            disable: async () => "off" as const,
          } as never),
        );
        await settle();
        const done = offer.setDevice(true);
        expect(offer.attempt()).toBe("busy");
        expect(offer.device(), "unchanged while busy").toBe(before);
        await done;
        expect(offer.device(), `${before} ${outcome}`).toBe(before);
        expect(offer.attempt(), `${before} ${outcome}`).toBe(outcome);
      }
    }
  });

  // Asked before the browser said how this device is: still unknown, its
  // read told once it ends; a refusal doesn't settle it.
  test("refused while this device is read: the read says it", async () => {
    let answer: (state: "on") => void = () => {};
    const offer = new NotificationOffer(
      undefined,
      Promise.resolve({
        state: () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
        enable: async () => "refused" as const,
      } as never),
    );
    await settle();
    expect(offer.device()).toBe("checking");
    await offer.setDevice(true);
    expect(offer.device()).toBe("checking");
    expect(offer.attempt()).toBe("refused");
    answer("on");
    await settle();
    expect(offer.device()).toBe("on");
    expect(offer.attempt()).toBe("refused");
  });

  // Begun before the gesture, the read is older than what it made.
  test("a read ending after a subscription: this device as subscribed", async () => {
    let answer: (state: "off") => void = () => {};
    const offer = new NotificationOffer(
      undefined,
      Promise.resolve({
        state: () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
        enable: async () => "on" as const,
      } as never),
    );
    await settle();
    await offer.setDevice(true);
    answer("off");
    await settle();
    expect(offer.device()).toBe("on");
  });

  test("an outcome said until the next gesture", async () => {
    let outcome: "refused" | "on" = "refused";
    const offer = new NotificationOffer(
      undefined,
      Promise.resolve({
        state: async () => "off" as const,
        enable: async () => outcome,
        disable: async () => "off" as const,
      } as never),
    );
    await settle();
    expect(offer.attempt()).toBe("idle");
    await offer.setDevice(true);
    expect(offer.attempt()).toBe("refused");
    outcome = "on";
    await offer.setDevice(true);
    expect([offer.device(), offer.attempt()]).toEqual(["on", "idle"]);
  });

  test("closed: nobody told, nothing changed", async () => {
    const offer = new NotificationOffer(
      browser("default", "granted"),
      Promise.resolve(device("off") as never),
    );
    await settle();
    let told = 0;
    offer.subscribe(() => told++);
    const asked = offer.request();
    offer.close();
    await asked;
    expect(told).toBe(0);
    expect(offer.permission()).toBe("default");
  });

  test("a listener removed isn't told", async () => {
    const offer = new NotificationOffer(
      browser("default", "granted"),
      undefined,
    );
    let told = 0;
    const stop = offer.subscribe(() => told++);
    stop();
    await offer.request();
    expect(told).toBe(0);
  });
});
