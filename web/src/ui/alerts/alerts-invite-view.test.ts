// @vitest-environment jsdom
// The invitation to be notified, in a view (phase 34j, NI1 – NI5): shown
// once I wrote, each button the gesture that asks, answered once per
// document, gone when the menu changes what it offers.
import { describe, expect, test } from "vitest";
import { setLanguage, t } from "../../i18n/index.js";
import type {
  DeviceEnableOutcome,
  DeviceNotificationState,
} from "../../push/device.js";
import { createAlertsInvite } from "./alerts-invite-view.js";
import { answeredInvites, rememberInvite } from "./alerts-invite.js";
import type { AlertPermission } from "./alerts.js";
import { NotificationOffer } from "./notification-offer.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (i) => [...items.keys()][i] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  };
}

async function setUp(
  options: {
    permission?: AlertPermission;
    answer?: AlertPermission;
    device?: DeviceNotificationState | "none";
    enabled?: DeviceEnableOutcome;
    storage?: Storage;
  } = {},
) {
  setLanguage("en");
  let permission = options.permission ?? "default";
  const calls: string[] = [];
  const attention = {
    permission: () => permission,
    request: async () => {
      calls.push("request");
      permission = options.answer ?? "granted";
      return permission;
    },
  };
  let device = options.device ?? "off";
  const control = {
    state: async () => device,
    enable: async () => {
      calls.push("enable");
      const outcome = options.enabled ?? "on";
      if (outcome === "on") {
        device = "on";
        permission = "granted";
      }
      return outcome;
    },
    disable: async () => {
      calls.push("disable");
      device = "off";
      return device;
    },
  };
  const offer = new NotificationOffer(
    attention,
    Promise.resolve(device === "none" ? undefined : (control as never)),
  );
  await settle();
  const container = document.createElement("div");
  document.body.append(container);
  const said: string[] = [];
  const storage = options.storage ?? memoryStorage();
  const invite = createAlertsInvite(container, {
    offer,
    documentId: "doc-1",
    storage,
    say: (text) => said.push(text),
  });
  const button = (name: string) =>
    container.querySelector<HTMLButtonElement>(`.${name}`);
  return { offer, container, invite, calls, said, storage, button };
}

describe("the invitation to be notified", () => {
  test("nothing until I write (NI1); then both tiers, and how to go back (NI2, NI5)", async () => {
    const v = await setUp();
    expect(v.container.querySelector(".alerts-invite")).toBeNull();
    v.invite.written();
    expect(v.button("invite-device")?.textContent).toBe(t().pushOffer);
    expect(v.button("invite-browser")?.textContent).toBe(t().alertsOffer);
    expect(v.button("invite-later")?.textContent).toBe(t().inviteLater);
    const text = v.container.textContent ?? "";
    expect(text).toContain(t().inviteQuestion);
    expect(text).toContain(t().inviteUndoDeviceBefore);
    expect(text).toContain(t().inviteUndoDeviceAfter);
    // The menu's icon, its name for a screen reader.
    expect(v.container.querySelector(".alerts-invite-menu svg")).not.toBeNull();
    expect(text).toContain(t().document);
    expect(
      v.container
        .querySelector('[role="status"]')
        ?.contains(v.button("invite-device") ?? null),
    ).toBe(true);
  });

  test("without Web Push: the browser alone, its settings to go back", async () => {
    const v = await setUp({ device: "none" });
    v.invite.written();
    expect(v.button("invite-device")).toBeNull();
    expect(v.button("invite-browser")).not.toBeNull();
    expect(v.container.textContent).toContain(t().inviteUndoBrowser);
  });

  test("this device: asked in the click, answered for this document", async () => {
    const v = await setUp();
    v.invite.written();
    v.button("invite-device")?.click();
    // In the gesture: a browser refuses a permission asked later.
    expect(v.calls).toEqual(["enable"]);
    expect(v.container.querySelector(".alerts-invite")).toBeNull();
    expect(answeredInvites(v.storage)).toEqual(["doc-1"]);
    await settle();
    expect(v.offer.device()).toBe("on");
    v.invite.written();
    expect(v.container.querySelector(".alerts-invite")).toBeNull();
    expect(v.said).toEqual([]);
  });

  test("written again while shown: still shown, unanswered", async () => {
    const v = await setUp();
    v.invite.written();
    v.invite.written();
    expect(v.button("invite-device")).not.toBeNull();
    expect(answeredInvites(v.storage)).toEqual([]);
  });

  test("the browser: asked in the click", async () => {
    const v = await setUp();
    v.invite.written();
    v.button("invite-browser")?.click();
    expect(v.calls).toEqual(["request"]);
    expect(answeredInvites(v.storage)).toEqual(["doc-1"]);
  });

  test("not now, or dismissed: answered, nothing asked", async () => {
    for (const name of ["invite-later", "notice-dismiss"]) {
      const v = await setUp();
      v.invite.written();
      v.button(name)?.click();
      expect(v.calls).toEqual([]);
      expect(v.container.querySelector(".alerts-invite")).toBeNull();
      expect(answeredInvites(v.storage)).toEqual(["doc-1"]);
    }
  });

  test("answered here before: not shown (NI3)", async () => {
    const storage = memoryStorage();
    rememberInvite(storage, "doc-1");
    const v = await setUp({ storage });
    v.invite.written();
    expect(v.container.querySelector(".alerts-invite")).toBeNull();
  });

  test("the menu turns on what it offers: gone, and answered (NI4)", async () => {
    const v = await setUp();
    v.invite.written();
    await v.offer.setDevice(true);
    expect(v.container.querySelector(".alerts-invite")).toBeNull();
    expect(answeredInvites(v.storage)).toEqual(["doc-1"]);
    await v.offer.setDevice(false);
    v.invite.written();
    expect(v.container.querySelector(".alerts-invite")).toBeNull();
  });

  test("this device refused, or without a key: said", async () => {
    for (const [enabled, text] of [
      ["refused", t().pushRefused],
      ["no-key", t().pushNeedsKey],
    ] as const) {
      const v = await setUp({ enabled });
      v.invite.written();
      v.button("invite-device")?.click();
      await settle();
      expect(v.said).toEqual([text]);
    }
  });

  test("closed before an answer: nothing kept, nothing shown after", async () => {
    const v = await setUp();
    v.invite.close();
    v.invite.written();
    expect(v.container.querySelector(".alerts-invite")).toBeNull();
    expect(answeredInvites(v.storage)).toEqual([]);
  });

  test("written before this device is known: shown once it is", async () => {
    setLanguage("en");
    let found: (control: unknown) => void = () => {};
    const offer = new NotificationOffer(
      { permission: () => "default", request: async () => "granted" },
      new Promise((resolve) => {
        found = resolve;
      }) as never,
    );
    const container = document.createElement("div");
    const invite = createAlertsInvite(container, {
      offer,
      documentId: "doc-1",
      storage: memoryStorage(),
      say: () => {},
    });
    invite.written();
    expect(container.querySelector(".alerts-invite")).toBeNull();
    found({
      state: async () => "off",
      enable: async () => "on",
      disable: async () => "off",
    });
    await settle();
    expect(container.querySelector(".invite-device")).not.toBeNull();
  });
});
