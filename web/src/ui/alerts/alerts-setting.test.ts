// @vitest-environment jsdom
// The notifications of the document menu (ADR-0060 §1): offered while the
// browser hasn't been asked, asked on a click only, the answer shown.
import { flushSync } from "svelte";
import { describe, expect, test } from "vitest";
import { setLanguage, t } from "../../i18n/index.js";
import { createAlertsSetting } from "./alerts-setting.js";
import type { AlertPermission } from "./alerts.js";
import { NotificationOffer } from "./notification-offer.js";

function mountWith(permission: AlertPermission, answer: AlertPermission) {
  setLanguage("en");
  const container = document.createElement("section");
  let asked = 0;
  const setting = createAlertsSetting(
    container,
    new NotificationOffer(
      {
        permission: () => permission,
        request: async () => {
          asked++;
          return answer;
        },
      },
      undefined,
    ),
  );
  flushSync();
  return { container, setting, asked: () => asked };
}

describe("the notifications of the document menu", () => {
  test("offered, asked on a click, then said granted", async () => {
    const m = mountWith("default", "granted");
    expect(m.asked()).toBe(0);
    const button =
      m.container.querySelector<HTMLButtonElement>(".alerts-request");
    expect(button?.textContent).toBe(t().alertsOffer);
    button?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(m.asked()).toBe(1);
    expect(m.container.textContent).toContain(t().alertsOn);
    expect(m.container.querySelector(".alerts-request")).toBeNull();
  });

  test("refused: said blocked", async () => {
    const m = mountWith("default", "denied");
    m.container.querySelector<HTMLButtonElement>(".alerts-request")?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(m.container.textContent).toContain(t().alertsBlocked);
  });

  test("nothing where the browser has no notifications", () => {
    const m = mountWith("unsupported", "unsupported");
    expect(m.container.textContent?.trim()).toBe("");
  });

  test("this device: offered, enabled on a click, then said on, and stopped", async () => {
    setLanguage("en");
    const container = document.createElement("section");
    let state: "on" | "off" = "off";
    const calls: string[] = [];
    const control = {
      state: async () => state,
      enable: async () => {
        calls.push("enable");
        state = "on";
        return state;
      },
      disable: async () => {
        calls.push("disable");
        state = "off";
        return state;
      },
    };
    createAlertsSetting(
      container,
      new NotificationOffer(undefined, Promise.resolve(control as never)),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const offer = container.querySelector<HTMLButtonElement>(".push-offer");
    expect(offer?.textContent).toBe(t().pushOffer);
    expect(container.textContent).toContain(t().alertsTitle);
    offer?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).toContain(t().pushOn);
    container.querySelector<HTMLButtonElement>(".push-stop")?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.querySelector(".push-offer")).not.toBeNull();
    expect(calls).toEqual(["enable", "disable"]);
  });

  test("this device without a key: said so, nothing written", async () => {
    setLanguage("en");
    const container = document.createElement("section");
    const control = {
      state: async () => "off",
      enable: async () => "no-key",
      disable: async () => "off",
    };
    createAlertsSetting(
      container,
      new NotificationOffer(undefined, Promise.resolve(control as never)),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    container.querySelector<HTMLButtonElement>(".push-offer")?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).toContain(t().pushNeedsKey);
  });

  // Offered while the browser is read; the read says on, after the
  // refusal: this device said on, and the refusal with it (phase 34j).
  test("refused while this device, on, is read: said on, and refused", async () => {
    setLanguage("en");
    const container = document.createElement("section");
    let answer: (state: "on") => void = () => {};
    const control = {
      state: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
      enable: async () => "refused",
    };
    createAlertsSetting(
      container,
      new NotificationOffer(undefined, Promise.resolve(control as never)),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    container.querySelector<HTMLButtonElement>(".push-offer")?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).toContain(t().pushRefused);
    answer("on");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).toContain(t().pushOn);
    expect(container.textContent).toContain(t().pushRefused);
    expect(container.querySelector(".push-stop")).not.toBeNull();
  });

  test("no device offered: nothing of it", async () => {
    setLanguage("en");
    const container = document.createElement("section");
    createAlertsSetting(
      container,
      new NotificationOffer(undefined, Promise.resolve(undefined)),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent?.trim()).toBe("");
  });
});
