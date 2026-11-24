// @vitest-environment jsdom
//
// The home in another host (docs/phase-18-trousseau-identite.md, analysis
// 18m, M5): the plugin's « Mes documents ». No « Nouveau document » (a
// note is shared instead); an entry opened by the host, never by the
// address; a pairing address pasted where the key goes; the gateway and
// the attestation keys the host's, never `/config.json` (OB3); the host
// told when this device's list changes.
import { IDBFactory } from "fake-indexeddb";
import { flushSync } from "svelte";
import { describe, expect, test } from "vitest";
import { createKeyring, rememberLink } from "../../lib/src/index.js";
import { FakeKeyringServer } from "../../lib/src/keyring/test-support/fake-keyring-server.js";
import { testLink } from "../../lib/src/keyring/test-support/links.js";
import { eventually } from "../../lib/src/transport/test-support/eventually.js";
import { t } from "../i18n/index.js";
import type { KeyringEnvironment } from "./environment.js";
import { type HomeOptions, type HomeView, mountHome } from "./home.js";
import { type KeyringLock, openKeyringLocal } from "./local.js";

const ORIGIN = "https://collab.test";
const GATEWAY = "https://accounts.test";

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

function device(
  server: FakeKeyringServer,
  asked: string[] = [],
): KeyringEnvironment {
  const local = openKeyringLocal({
    indexedDB: new IDBFactory(),
    lock: memoryLock(),
  });
  return {
    local,
    fetch: (url, init) => {
      asked.push(url);
      return server.fetch(url, init);
    },
    setTimer: (run) => {
      const timer = setTimeout(run, 0);
      return () => clearTimeout(timer);
    },
    account: {
      local,
      openWindow: () => {},
      channel: () => ({ post: () => {}, listen: () => () => {} }),
    },
  };
}

function plugin(
  keyring: KeyringEnvironment,
  server: FakeKeyringServer,
  more: Partial<HomeOptions> = {},
): HomeView {
  document.body.innerHTML = "";
  return mountHome(document.body, {
    apiBase: ORIGIN,
    keyring,
    createKeyring: () => createKeyring(ORIGIN, server.fetch),
    confirm: () => true,
    copy: async () => {},
    now: () => 1_000,
    newDocument: false,
    openEntry: () => {},
    config: {},
    ...more,
  });
}

const $ = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector);
const text = () => document.body.textContent ?? "";
const click = (selector: string) => {
  $(selector)?.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true }),
  );
  flushSync();
};
const type = (selector: string, value: string) => {
  const input = $<HTMLInputElement>(selector);
  if (!input) throw new Error(`no ${selector}`);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
};

/** A list kept on `env`'s device, holding `doc`. */
async function kept(env: KeyringEnvironment, server: FakeKeyringServer) {
  const changed: number[] = [];
  const view = plugin(env, server, {
    onKeyringChanged: () => changed.push(1),
  });
  await view.ready;
  click(".home-keep");
  await eventually(() => view.session() !== undefined);
  await view
    .session()
    ?.change((d) => void rememberLink(d, testLink("d1", "edit", 0), { at: 1 }));
  expect(await view.session()?.sync()).toBe("synced");
  click(".home-kept");
  return { view, changed };
}

describe("the home in the plugin", () => {
  test("no « Nouveau document »: a note is shared instead", async () => {
    const server = new FakeKeyringServer();
    const view = plugin(device(server), server);
    await view.ready;
    expect($(".home-new")).toBeNull();
    view.close();
  });

  test("an entry opens through the host, never by its address", async () => {
    const server = new FakeKeyringServer();
    const opened: string[] = [];
    const env = device(server);
    const first = await kept(env, server);
    first.view.close();
    const view = plugin(env, server, {
      openEntry: (link) => opened.push(link),
    });
    await view.ready;
    await eventually(() => $(".home-entry-link") !== null);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    $(".home-entry-link")?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(opened).toEqual([testLink("d1", "edit", 0)]);
    view.close();
  });

  test("the host is told when this device's list changes", async () => {
    const server = new FakeKeyringServer();
    const { view, changed } = await kept(device(server), server);
    expect(changed.length).toBeGreaterThan(0);
    view.close();
  });

  test("a pairing address pasted where the key goes joins the list", async () => {
    const server = new FakeKeyringServer();
    const holder = await kept(device(server), server);
    click(".home-add-device");
    await eventually(() => $(".home-pairing-link") !== null);
    const address = $<HTMLInputElement>(".home-pairing-link")?.value ?? "";
    holder.view.close();
    const view = plugin(device(server), server);
    await view.ready;
    type(".home-find", address);
    click(".home-open");
    await eventually(() => text().includes(t().pairingJoined));
    await eventually(() => $(".home-entry") !== null);
    expect($(".home-entry")?.getAttribute("data-document")).toBe("d1");
    view.close();
  });

  test("OB3: the host's gateway and keys, never /config.json", async () => {
    const server = new FakeKeyringServer();
    const asked: string[] = [];
    const view = plugin(device(server, asked), server, {
      config: { gateway: GATEWAY, attestationKeys: ["a".repeat(64)] },
    });
    await view.ready;
    await view.accountReady;
    expect(asked.some((url) => url.endsWith("/config.json"))).toBe(false);
    expect(asked).toContain(`${GATEWAY}/accounts/health`);
    view.close();
  });
});
