// @vitest-environment jsdom
// The invitation to be notified under a controlled order (AGENTS.md §1.6;
// phase 34j, NI1 – NI4): what I write, the end of each call to the
// browser (the permission asked, this device's state read, its
// subscription made or deleted), the menu's actions, the invitation's
// buttons, the view reloaded on one of two documents, or closed: each
// when Hegel says. The server offers Web Push or not, for the whole case.
//
// At every step: shown only once I wrote in this view (NI1), its buttons
// what is left to turn on, never while this device is unknown or changing
// (NI2); never in a document where it was answered, and, without this
// device, only before any answer (NI3); each button asks the browser in
// its click; closed, nothing shown and nothing remembered; a subscription
// refused or unsigned leaves this device as the view had it. Once quiet:
// this device said as the browser has it, a menu's change while shown an
// answer (NI4), and shown if it has something to offer.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import { setLanguage } from "../../i18n/index.js";
import type {
  DeviceEnableOutcome,
  DeviceNotificationState,
} from "../../push/device.js";
import { createAlertsInvite } from "./alerts-invite-view.js";
import { answeredInvites } from "./alerts-invite.js";
import type { AlertPermission } from "./alerts.js";
import { NotificationOffer } from "./notification-offer.js";

type TC = Parameters<Parameters<typeof hegel.testAsync>[0]>[0];
type Held = { label: string; view: number; release: (tc: TC) => void };

const DOCS = ["doc-1", "doc-2"];

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

const settle = async () => {
  // Every microtask run, however long its chain: a macrotask comes after.
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const inviteScenario = async (tc: TC): Promise<void> => {
  setLanguage("en");
  const storage = memoryStorage();
  const push = tc.draw(gs.booleans());
  /** The browser: its permission, and this device in each document. */
  // Changed in the calls' answers, out of the compiler's sight.
  let permission = "default" as AlertPermission;
  const entries = new Map<string, DeviceNotificationState>();
  const held: Held[] = [];
  /** Calls to the browser that a gesture must make. */
  let asked = 0;
  /** The view whose calls are being made. */
  let views = 0;
  const hold = <T>(
    label: string,
    view: number,
    answer: (tc: TC) => T,
  ): Promise<T> =>
    new Promise((resolve) => {
      held.push({ label, view, release: (tc) => resolve(answer(tc)) });
    });

  /** A subscription that failed, and this device as its view had it. */
  let failed: { view: number; before: string } | undefined;
  let view: ReturnType<typeof openView> | undefined;
  function openView(doc: string) {
    const id = ++views;
    let raced = false;
    const container = document.createElement("div");
    const control = {
      // Read when asked, told when Hegel says: what changed meanwhile
      // isn't in it.
      state: () => {
        const now = entries.get(doc) === "on" ? "on" : "off";
        // Another view's change still going: this read may miss it, as
        // any view misses what another tab changes (the next opening
        // reads it again).
        raced ||= held.some(
          (h) =>
            (h.label === "enable" || h.label === "disable") && h.view !== id,
        );
        return hold("state", id, () => now);
      },
      enable: () => {
        asked++;
        return hold("enable", id, (tc): DeviceEnableOutcome => {
          const outcome = tc.draw(
            gs.sampledFrom(["on", "refused", "no-key"] as const),
          );
          const fail = (why: "refused" | "no-key") => {
            failed = { view: id, before: offer.device() };
            return why;
          };
          if (outcome === "refused") {
            if (permission === "default") permission = "denied";
            return fail("refused");
          }
          if (permission === "denied") return fail("refused");
          permission = "granted";
          if (outcome === "on") entries.set(doc, "on");
          else return fail(outcome);
          return outcome;
        });
      },
      disable: () =>
        hold("disable", id, (): "off" => {
          entries.set(doc, "off");
          return "off";
        }),
    };
    const offer = new NotificationOffer(
      {
        permission: () => permission,
        request: () => {
          asked++;
          return hold("request", id, (tc) => {
            if (permission === "default") {
              permission = tc.draw(
                gs.sampledFrom(["granted", "denied"] as const),
              );
            }
            return permission;
          });
        },
      },
      hold("device", id, () => (push ? (control as never) : undefined)),
    );
    const invite = createAlertsInvite(container, {
      offer,
      documentId: doc,
      storage,
      say: () => {},
    });
    return {
      id,
      doc,
      container,
      offer,
      invite,
      wrote: false,
      closed: false,
      /** A menu's action taken while shown. */
      menuWhileShown: false,
      get raced() {
        return raced;
      },
    };
  }

  const shown = () =>
    view?.container.querySelector(".alerts-invite") ? view : undefined;
  const button = (name: string) =>
    view?.container.querySelector<HTMLButtonElement>(`.${name}`) ?? null;

  const check = (step: string) => {
    const v = view;
    if (!v) return;
    const list = answeredInvites(storage);
    // Settled by its read alone, if the browser hadn't said it yet.
    if (
      failed?.view === v.id &&
      !v.closed &&
      failed.before !== "checking" &&
      v.offer.device() !== failed.before
    ) {
      throw new Error(
        `${step}: a failed subscription said this device ${v.offer.device()}, not ${failed.before}`,
      );
    }
    failed = undefined;
    if (v.closed) {
      if (shown()) throw new Error(`${step}: shown once closed`);
      return;
    }
    if (!shown()) return;
    if (!v.wrote) throw new Error(`NI1 (${step}): shown before I wrote`);
    const device = v.offer.device();
    const attempt = v.offer.attempt();
    const p = v.offer.permission();
    if (["pending", "checking"].includes(device) || attempt === "busy") {
      throw new Error(
        `NI2 (${step}): shown while this device is ${device}, ${attempt}`,
      );
    }
    const offersDevice =
      device === "off" && attempt === "idle" && p !== "denied";
    if ((button("invite-device") !== null) !== offersDevice) {
      throw new Error(
        `NI2 (${step}): this device offered wrongly (${device}, ${p})`,
      );
    }
    if ((button("invite-browser") !== null) !== (p === "default")) {
      throw new Error(`NI2 (${step}): the browser offered wrongly (${p})`);
    }
    if (list.includes(v.doc)) {
      throw new Error(`NI3 (${step}): shown where it was answered`);
    }
    if (!offersDevice && list.length > 0) {
      throw new Error(`NI3 (${step}): the permission alone, after an answer`);
    }
  };

  view = openView(tc.draw(gs.sampledFrom(DOCS)));
  const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 30 }));
  for (let step = 0; step < steps; step++) {
    const v = view;
    const moves = [
      ...(held.length > 0 ? ["release", "release", "release"] : []),
      ...(v.closed
        ? ["reload"]
        : ["write", "write", "menu", "reload", "close"]),
      // The menu while this device's state is read, the read answered
      // last, or first: one composed gesture each, too long for chance.
      ...(!v.closed && v.offer.device() === "checking"
        ? ["menuBeforeRead", "menuReadFirst"]
        : []),
      ...(shown() ? ["click", "click"] : []),
    ];
    const move = tc.draw(gs.sampledFrom(moves));
    if (move === "release") {
      const i = tc.draw(
        gs.integers({ minValue: 0, maxValue: held.length - 1 }),
      );
      const [taken] = held.splice(i, 1);
      taken?.release(tc);
    } else if (move === "write") {
      v.wrote = true;
      v.invite.written();
    } else if (move === "menu") {
      // What the menu shows: the permission while it is to ask, this
      // device once the server and the browser offer it.
      const device = v.offer.device();
      const actions = [
        ...(v.offer.permission() === "default" ? ["request" as const] : []),
        ...(v.offer.attempt() === "busy" ||
        ["pending", "unsupported"].includes(device)
          ? []
          : device === "on"
            ? ["off" as const]
            : ["on" as const]),
      ];
      if (actions.length > 0) {
        const action = tc.draw(gs.sampledFrom(actions));
        if (shown()) v.menuWhileShown = true;
        if (action === "request") void v.offer.request();
        else void v.offer.setDevice(action === "on");
      }
    } else if (move === "menuReadFirst") {
      if (shown()) v.menuWhileShown = true;
      const read = held.findIndex(
        (h) => h.label === "state" && h.view === v.id,
      );
      if (read < 0) throw new Error("no read");
      void v.offer.setDevice(true);
      await settle();
      held.splice(read, 1)[0]?.release(tc);
      await settle();
      const enable = held.findIndex(
        (h) => h.label === "enable" && h.view === v.id,
      );
      if (enable < 0) throw new Error("no subscription");
      held.splice(enable, 1)[0]?.release(tc);
    } else if (move === "menuBeforeRead") {
      if (shown()) v.menuWhileShown = true;
      const read = held.findIndex(
        (h) => h.label === "state" && h.view === v.id,
      );
      void v.offer.setDevice(true);
      await settle();
      const enable = held.findIndex(
        (h) => h.label === "enable" && h.view === v.id,
      );
      if (read < 0 || enable < read)
        throw new Error("no read, or no subscription");
      held.splice(enable, 1)[0]?.release(tc);
      await settle();
      held.splice(read, 1)[0]?.release(tc);
    } else if (move === "click") {
      const names = [
        "invite-device",
        "invite-browser",
        "invite-later",
        "notice-dismiss",
      ].filter((name) => button(name) !== null);
      const name = tc.draw(gs.sampledFrom(names));
      const before = asked;
      const listBefore = answeredInvites(storage);
      button(name)?.click();
      // In the gesture: a browser refuses what is asked later.
      const expected =
        name === "invite-device" || name === "invite-browser" ? 1 : 0;
      if (asked - before !== expected) {
        throw new Error(
          `${name}: ${asked - before} calls to the browser in the click`,
        );
      }
      if (shown()) throw new Error(`${name}: still shown once answered`);
      if (
        !answeredInvites(storage).includes(v.doc) ||
        listBefore.includes(v.doc)
      ) {
        throw new Error(`NI3: ${name} not remembered`);
      }
    } else if (move === "close" || move === "reload") {
      if (!v.closed) {
        const before = JSON.stringify(answeredInvites(storage));
        v.invite.close();
        v.offer.close();
        v.closed = true;
        if (JSON.stringify(answeredInvites(storage)) !== before) {
          throw new Error("closed: something remembered");
        }
      }
      if (move === "reload") view = openView(tc.draw(gs.sampledFrom(DOCS)));
    }
    await settle();
    check(`step ${step}, ${move}`);
  }
  // Quiet: everything the browser was asked, answered.
  while (held.length > 0) {
    held.shift()?.release(tc);
    await settle();
    check("draining");
  }
  const v = view;
  if (v.closed) return;
  const device = v.offer.device();
  if (push && !v.raced && (device === "on") !== (entries.get(v.doc) === "on")) {
    throw new Error(
      `this device said ${device}, the browser has ${entries.get(v.doc) ?? "off"}`,
    );
  }
  const list = answeredInvites(storage);
  if (v.menuWhileShown && (shown() || !list.includes(v.doc))) {
    throw new Error("NI4: a menu's change while shown isn't an answer");
  }
  const offersDevice =
    device === "off" && v.offer.attempt() === "idle" && permission !== "denied";
  const something = offersDevice || permission === "default";
  const due =
    v.wrote &&
    something &&
    !list.includes(v.doc) &&
    (offersDevice || list.length === 0);
  if (due && !shown()) throw new Error("not shown, though due");
};

/** A `tc` that gives back recorded draws, in order (Hegel prints them as
 * `draw_1`, `draw_2`… when a case fails); `done` says whether all were
 * taken. */
function replay(draws: readonly (number | string | boolean)[]) {
  let next = 0;
  const tc = {
    draw: () => {
      if (next >= draws.length) throw new Error("more draws than recorded");
      return draws[next++];
    },
  } as unknown as TC;
  return { tc, done: () => next === draws.length };
}

describe("the invitation to be notified (controlled order)", () => {
  test(
    "shown once I wrote, what is left to offer, once per document; asked in the gesture",
    () => hegel.testAsync(inviteScenario, { testCases: 400 }),
    600_000,
  );

  // Found on 2026-11-19 by `./ci.sh` (phase 34j), a fault of the
  // scenario's: this device turned on, then off from the menu, the view
  // reloaded before the deletion ended; the new view read this device
  // meanwhile, and kept what it read. A view doesn't follow what another
  // changes; the scenario no longer asks it of a read made while another
  // view's change was going.
  test("a counter-example kept: a read while another view turns this device off", async () => {
    const { tc, done } = replay([
      true,
      "doc-1",
      10,
      "close",
      "release",
      0,
      "reload",
      "doc-1",
      "release",
      0,
      "write",
      "write",
      "menuBeforeRead",
      "on",
      "menu",
      "off",
      "reload",
      "doc-1",
      "release",
      1,
    ]);
    await inviteScenario(tc);
    expect(done()).toBe(true);
  }, 60_000);

  // Found on 2026-11-19 by `./ci.sh`: this device turned on, the view
  // reloaded; while the new view reads this device, the menu turns it on
  // again and the browser refuses. The refusal leaves the entry as it
  // was, on: the view said refused.
  test("a counter-example kept: refused while this device, already on, is read", async () => {
    const { tc, done } = replay([
      true,
      "doc-1",
      9,
      "release",
      0,
      "menuBeforeRead",
      "on",
      "write",
      "write",
      "write",
      "write",
      "reload",
      "doc-1",
      "release",
      0,
      "menuBeforeRead",
      "refused",
    ]);
    await inviteScenario(tc);
    expect(done()).toBe(true);
  }, 60_000);

  // Found on 2026-11-20 (phase 37g, without relation to it): this device
  // turned on, the view reloaded; in the new one, the menu turns it on
  // while its state is read, the subscription refused, the read answered
  // last with « on ». The view said « refused », the browser had it on.
  test("a counter-example kept: a refused subscription while this device, already on, is read", async () => {
    const { tc, done } = replay([
      true,
      "doc-2",
      9,
      "release",
      0,
      "release",
      0,
      "menu",
      "on",
      "release",
      0,
      "on",
      "write",
      "write",
      "reload",
      "doc-2",
      "release",
      0,
      "menuBeforeRead",
      "refused",
    ]);
    await inviteScenario(tc);
    expect(done()).toBe(true);
  }, 60_000);
});
