// @vitest-environment jsdom
//
// Signing in from the home (analysis 18i.2; ADR-0041): « S'identifier »
// once the configuration names a gateway that answers; the window opened
// in the click itself; « Identification en cours… » and « Annuler »; signed in,
// the name, « Se déconnecter »; refusals said. On fake-indexeddb, a
// gateway and the pages' channels in memory.
import { IDBFactory } from "fake-indexeddb";
import { flushSync } from "svelte";
import { describe, expect, onTestFinished, test } from "vitest";
import { createKeyring } from "../../lib/src/index.js";
import { FakeKeyringServer } from "../../lib/src/keyring/test-support/fake-keyring-server.js";
import { ActivityCount } from "../../lib/src/transport/test-support/activity-count.js";
import { t } from "../i18n/index.js";
import type { KeyringEnvironment } from "../keyring/environment.js";
import { type HomeView, mountHome } from "../keyring/home.js";
import { type KeyringLock, openKeyringLocal } from "../keyring/local.js";
import { SIGN_IN_CHANNEL } from "./channels.js";
import {
  ChannelBus,
  codeOf,
  requestOf,
  sessionAnswer,
} from "./test-support.js";

const ORIGIN = "https://collab.test";
const GATEWAY = "https://accounts.example";

function memoryLock(): KeyringLock {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    exclusive(_name, run) {
      const result = tail.then(run, run);
      tail = result.catch(() => {});
      return result;
    },
  };
}

interface Device {
  env: KeyringEnvironment;
  opened: string[];
  bus: ChannelBus;
  /** What the gateway answers an exchange. */
  exchange: () => Response;
  asked: string[];
  /** What the home has in progress (AGENTS.md §1.6): its requests, the
   * device's stores, its timers, WebCrypto. */
  activity: ActivityCount;
}

function device(options: { gateway?: unknown; healthy?: boolean } = {}) {
  const server = new FakeKeyringServer();
  const activity = new ActivityCount();
  onTestFinished(activity.countCrypto());
  const local = activity.methods(
    openKeyringLocal({
      indexedDB: new IDBFactory(),
      lock: memoryLock(),
    }),
  );
  const bus = new ChannelBus();
  const dev: Device = {
    opened: [],
    bus,
    exchange: () => sessionAnswer(codeOf(9)),
    asked: [],
    activity,
    env: undefined as unknown as KeyringEnvironment,
  };
  dev.env = {
    local,
    fetch: activity.counted(async (url: string, init?: RequestInit) => {
      const { origin, pathname } = new URL(url);
      if (origin === GATEWAY) {
        dev.asked.push(pathname);
        if (pathname === "/accounts/health") {
          if (options.healthy === false) throw new TypeError("offline");
          return new Response("{}", { status: 200 });
        }
        if (pathname === "/accounts/session") return dev.exchange();
        if (pathname === "/accounts/logout")
          return new Response(null, { status: 204 });
      }
      if (pathname === "/config.json") {
        return new Response(
          JSON.stringify(
            "gateway" in options ? { gateway: options.gateway } : {},
          ),
        );
      }
      return server.fetch(url, init);
    }),
    // A short wait shortened; a far one (a token's deadline) never comes,
    // nor is waited for.
    setTimer: (run, ms) => {
      if (ms >= 60_000) return () => {};
      return activity.timers((go, after) => {
        const timer = setTimeout(go, Math.min(after, 50));
        return () => clearTimeout(timer);
      })(run, ms);
    },
    account: {
      local,
      openWindow: (url) => dev.opened.push(url),
      channel: (name) => bus.channel(name),
    },
  };
  return { dev, server };
}

/** Once nothing is in progress, `holds` holds. */
async function until(dev: Device, holds: () => boolean): Promise<void> {
  await dev.activity.settled();
  expect(holds()).toBe(true);
}

function home(dev: Device, server: FakeKeyringServer): HomeView {
  document.body.innerHTML = "";
  return mountHome(document.body, {
    apiBase: ORIGIN,
    keyring: dev.env,
    createKeyring: () => createKeyring(ORIGIN, server.fetch),
    confirm: () => true,
    copy: async () => {},
    now: () => Date.now(),
  });
}

const $ = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector);
const text = () => document.body.textContent ?? "";
const click = (selector: string) => {
  $(selector)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  flushSync();
};

/** The window comes back for the attempt it was opened with. */
function windowReturns(dev: Device, data: Record<string, string>) {
  dev.bus.postFromElsewhere(SIGN_IN_CHANNEL, {
    request: requestOf(dev.opened.at(-1) as string),
    ...data,
  });
  dev.bus.deliverAll();
}

describe("signing in from the home", () => {
  test("no gateway configured, or none that answers: nothing of an account", async () => {
    for (const options of [{}, { gateway: "not an origin" }]) {
      const { dev, server } = device(options);
      const view = home(dev, server);
      await view.accountReady;
      expect($(".home-account")).toBeNull();
      expect(dev.asked).toEqual([]);
    }
    const { dev, server } = device({ gateway: GATEWAY, healthy: false });
    const view = home(dev, server);
    await view.accountReady;
    expect(dev.asked).toEqual(["/accounts/health"]);
    expect($(".home-sign-in")).toBeNull();
  });

  test("the click opens the window itself; the return signs in; signing out", async () => {
    const { dev, server } = device({ gateway: GATEWAY });
    const view = home(dev, server);
    await view.accountReady;
    await until(dev, () => !$<HTMLButtonElement>(".home-sign-in")?.disabled);
    click(".home-sign-in");
    // In the click, without waiting (ADR-0041, point 6).
    expect(dev.opened).toHaveLength(1);
    expect(new URL(dev.opened[0] as string).origin).toBe(GATEWAY);
    expect(text()).toContain(t().signInPending);
    windowReturns(dev, { code: codeOf(7) });
    await until(dev, () => $(".home-sign-out") !== null);
    expect(text()).toContain(
      t().identityLabel(undefined, "Ada (ada@example.org)"),
    );
    expect(await dev.env.account?.local.signedIn()).toMatchObject({
      token: codeOf(9),
      sub: "u-1",
    });
    click(".home-sign-out");
    await until(dev, () => $(".home-sign-in") !== null);
    expect(await dev.env.account?.local.signedIn()).toBeUndefined();
    await until(dev, () => dev.asked.includes("/accounts/logout"));
    view.close();
  });

  test("« Annuler », and refusals said", async () => {
    const { dev, server } = device({ gateway: GATEWAY });
    const view = home(dev, server);
    await view.accountReady;
    await until(dev, () => !$<HTMLButtonElement>(".home-sign-in")?.disabled);
    click(".home-sign-in");
    click(".home-sign-in-cancel");
    expect($(".home-sign-in")).not.toBeNull();
    // A return after « Annuler »: nothing.
    windowReturns(dev, { code: codeOf(7) });
    await dev.activity.settled();
    expect(dev.asked).not.toContain("/accounts/session");

    await until(dev, () => !$<HTMLButtonElement>(".home-sign-in")?.disabled);
    click(".home-sign-in");
    windowReturns(dev, { error: "denied" });
    await until(dev, () => text().includes(t().signInDenied));

    await until(dev, () => !$<HTMLButtonElement>(".home-sign-in")?.disabled);
    dev.exchange = () => new Response(null, { status: 401 });
    click(".home-sign-in");
    windowReturns(dev, { code: codeOf(8) });
    await until(dev, () => text().includes(t().signInFailed));
    view.close();
  });

  test("closed, the home hears nothing more", async () => {
    const { dev, server } = device({ gateway: GATEWAY });
    const view = home(dev, server);
    await view.accountReady;
    await until(dev, () => !$<HTMLButtonElement>(".home-sign-in")?.disabled);
    click(".home-sign-in");
    view.close();
    windowReturns(dev, { code: codeOf(7) });
    await dev.activity.settled();
    expect(dev.asked).not.toContain("/accounts/session");
  });
});
