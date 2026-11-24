// @vitest-environment jsdom
//
// Adding a device (docs/protocol/05-keyring.md, KR-31 – KR-37; analysis
// 18f): « Ajouter un appareil » shows a code — a QR code and its link —
// that opens the same list on another device, once, for 5 minutes; a code
// taken, expired or unreadable is said so; a device that had a list of its
// own joins it to the one given (case 6); a code shown is hidden when the
// key changes (case 3). On fake-indexeddb and a keyring server in memory,
// whose clock the test moves.
import { IDBFactory } from "fake-indexeddb";
import jsQR from "jsqr";
import { flushSync } from "svelte";
import { describe, expect, test } from "vitest";
import {
  type PairingAddress,
  createKeyring,
  decryptKeyring,
  listKeyring,
  readKeyringPlaintext,
  readPairingAddress,
  rememberLink,
} from "../../lib/src/index.js";
import { FakeKeyringServer } from "../../lib/src/keyring/test-support/fake-keyring-server.js";
import { testLink } from "../../lib/src/keyring/test-support/links.js";
import { eventually } from "../../lib/src/transport/test-support/eventually.js";
import { t } from "../i18n/index.js";
import type { KeyringEnvironment } from "./environment.js";
import { type HomeView, PAIRING_SHOWN_MS, mountHome } from "./home.js";
import { openKeyringLocal } from "./local.js";

const ORIGIN = "https://collab.test";

const lock = {
  exclusive: <T>(_name: string, run: () => Promise<T>) => run(),
};

/** One device: its IndexedDB, and its timers — at once for a session's
 * first synchronisation (0 ms), the others fired by the test. */
function device(server: FakeKeyringServer) {
  const timers: { ms: number; run: () => void; live: boolean }[] = [];
  const env: KeyringEnvironment = {
    local: openKeyringLocal({ indexedDB: new IDBFactory(), lock }),
    fetch: server.fetch,
    setTimer: (run, ms) => {
      if (ms === 0) {
        const at = setTimeout(run, 0);
        return () => clearTimeout(at);
      }
      const timer = { ms, run, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
  };
  /** Fires the live timers of `ms`. */
  const fire = (ms: number) => {
    for (const timer of timers.filter((x) => x.live && x.ms === ms)) {
      timer.live = false;
      timer.run();
    }
  };
  return { env, fire };
}

function home(
  keyring: KeyringEnvironment | undefined,
  server: FakeKeyringServer,
  pairing?: PairingAddress | "unreadable",
  confirm: (message: string) => boolean = () => true,
): HomeView {
  document.body.innerHTML = "";
  return mountHome(document.body, {
    apiBase: ORIGIN,
    ...(keyring && { keyring }),
    ...(pairing && { pairing }),
    createKeyring: () => createKeyring(ORIGIN, server.fetch),
    confirm,
    copy: async () => {},
    now: () => 1_000,
  });
}

const $ = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector);
const text = () => document.body.textContent ?? "";
const click = (selector: string) => {
  $(selector)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  flushSync();
};
const documents = () =>
  Array.from(document.querySelectorAll(".home-entry")).map((e) =>
    e.getAttribute("data-document"),
  );

/** A device holding a list of `docs`, its home open. */
async function holder(server: FakeKeyringServer, docs: string[]) {
  const { env, fire } = device(server);
  const view = home(env, server);
  await view.ready;
  click(".home-keep");
  await eventually(() => view.session() !== undefined);
  for (const doc of docs) {
    await view
      .session()
      ?.change(
        (d) => void rememberLink(d, testLink(doc, "edit", 0), { at: 1 }),
      );
  }
  expect(await view.session()?.sync()).toBe("synced");
  click(".home-kept");
  return { view, env, fire };
}

/** Shows a code on the holder's home; the address it shows. */
async function showCode(): Promise<PairingAddress> {
  click(".home-add-device");
  await eventually(() => $(".home-pairing-link") !== null);
  const address = $<HTMLInputElement>(".home-pairing-link")?.value ?? "";
  // The QR code is that address.
  const svg = $(".home-pairing-qr");
  const size = Number(svg?.getAttribute("viewBox")?.split(" ")[2]);
  const path = svg?.querySelector("path")?.getAttribute("d") ?? "";
  const side = size * 4;
  const pixels = new Uint8ClampedArray(side * side * 4).fill(255);
  for (const [, x, y] of path.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
    for (let d = 0; d < 16; d++) {
      const px = Number(x) * 4 + (d % 4);
      const py = Number(y) * 4 + Math.floor(d / 4);
      pixels.fill(0, (py * side + px) * 4, (py * side + px) * 4 + 3);
    }
  }
  expect(jsQR(pixels, side, side)?.data).toBe(address);
  const url = new URL(address);
  expect(url.origin).toBe(ORIGIN);
  const pairing = readPairingAddress(url.search, url.hash);
  if (!pairing) throw new Error(`not a pairing address: ${address}`);
  return pairing;
}

describe("adding a device", () => {
  test("the code opens the same list on another device, once", async () => {
    const server = new FakeKeyringServer();
    const a = await holder(server, ["d1"]);
    const pairing = await showCode();
    // TR3: the server holds the deposit, never the key nor the list's.
    const [deposit] = [...server.deposits.values()];
    const sealed = Buffer.from(deposit?.blob ?? []).toString("latin1");
    expect(sealed).not.toContain("oc-keyring");
    a.view.close();

    const b = device(server);
    const viewB = home(b.env, server, pairing);
    await viewB.ready;
    await eventually(() => documents().includes("d1"));
    expect(text()).toContain(t().pairingJoined);
    expect(server.deposits.size).toBe(0);
    // A list B writes into is A's.
    await viewB
      .session()
      ?.change(
        (d) => void rememberLink(d, testLink("d2", "edit", 0), { at: 2 }),
      );
    expect(await viewB.session()?.sync()).toBe("synced");
    const [kept] = [...server.keyrings.values()];
    const list = readKeyringPlaintext(
      await decryptKeyring(
        viewB.session()?.ref.key ?? new Uint8Array(),
        kept?.blob ?? new Uint8Array(),
      ),
    );
    expect(
      listKeyring(list ?? viewB.session()?.doc ?? ({} as never)).map(
        (e) => e.documentId,
      ),
    ).toEqual(["d1", "d2"]);
    viewB.close();

    // Taken: a third device is told so, and how to react.
    const c = device(server);
    const viewC = home(c.env, server, pairing);
    await viewC.ready;
    expect(text()).toContain(t().pairingGone);
    expect(viewC.session()).toBeUndefined();
    viewC.close();
  });

  test("a code expires with the server's clock; the page offers a new one", async () => {
    const server = new FakeKeyringServer();
    const a = await holder(server, ["d1"]);
    const pairing = await showCode();
    // The page's own timer says it's over, and offers another.
    a.fire(PAIRING_SHOWN_MS);
    flushSync();
    expect(text()).toContain(t().pairingExpired);
    expect($(".home-pairing-qr")).toBeNull();
    // The server's clock decides: past its 300 seconds, nothing given.
    server.now += 300;
    const late = device(server);
    const viewLate = home(late.env, server, pairing);
    await viewLate.ready;
    expect(text()).toContain(t().pairingGone);
    viewLate.close();
    // A new code works.
    const fresh = home(a.env, server);
    await fresh.ready;
    const again = await showCode();
    click(".home-pairing-done");
    expect($(".home-pairing")).toBeNull();
    fresh.close();
    const b = device(server);
    const viewB = home(b.env, server, again);
    await viewB.ready;
    await eventually(() => documents().includes("d1"));
    viewB.close();
  });

  // Security review of 18f: a code is an address anyone can send. A
  // device with a list of its own never gives it to another list without
  // asking — whoever holds that list would see every document of it.
  test("a device with a list of its own keeps it, unless its user agrees to join them", async () => {
    const server = new FakeKeyringServer();
    const a = await holder(server, ["d1"]);
    const first = await showCode();
    const second = await showCode();
    a.view.close();
    const b = await holder(server, ["d9"]);
    const own = b.view.session()?.ref.keyringId;
    b.view.close();
    // Declined: nothing changes here, nothing of B's reaches A's list.
    const asked: string[] = [];
    let viewB = home(b.env, server, first, (message) => {
      asked.push(message);
      return false;
    });
    await viewB.ready;
    expect(asked).toEqual([t().pairingMergeConfirm]);
    expect(viewB.session()?.ref.keyringId).toBe(own);
    await eventually(() => documents().includes("d9"));
    expect(documents()).not.toContain("d1");
    expect(text()).toContain(t().pairingKeptOwn);
    viewB.close();
    let viewA = home(a.env, server);
    await viewA.ready;
    expect(await viewA.session()?.sync()).toBe("synced");
    expect(documents()).toEqual(["d1"]);
    viewA.close();
    // Agreed: the two lists join.
    viewB = home(b.env, server, second, () => true);
    await viewB.ready;
    await eventually(
      () => documents().includes("d1") && documents().includes("d9"),
    );
    expect(text()).toContain(t().pairingMerged);
    expect(await viewB.session()?.sync()).toBe("synced");
    viewA = home(a.env, server);
    await viewA.ready;
    expect(await viewA.session()?.sync()).toBe("synced");
    await eventually(() => documents().includes("d9"));
    viewA.close();
    viewB.close();
  });

  test("an unreadable code is said so; nothing is taken without storage", async () => {
    const server = new FakeKeyringServer();
    const a = await holder(server, ["d1"]);
    const pairing = await showCode();
    a.view.close();
    const b = device(server);
    // The right deposit under another key: unreadable, and it's gone.
    const wrong = { ...pairing, key: new Uint8Array(32).fill(1) };
    let view = home(b.env, server, wrong);
    await view.ready;
    expect(text()).toContain(t().pairingUnreadable);
    view.close();
    view = home(b.env, server, "unreadable");
    await view.ready;
    expect(text()).toContain(t().pairingUnreadable);
    view.close();
    // A browser that keeps nothing doesn't take a deposit it can't keep.
    const holderAgain = home(a.env, server);
    await holderAgain.ready;
    const another = await showCode();
    holderAgain.close();
    view = home(undefined, server, another);
    await view.ready;
    expect(text()).toContain(t().keyringUnavailable);
    expect(server.deposits.size).toBe(1);
    view.close();
  });

  test("too many codes waiting is said; changing the key hides the code", async () => {
    const server = new FakeKeyringServer();
    const a = await holder(server, ["d1"]);
    for (let n = 0; n < 8; n++) await showCode();
    click(".home-add-device");
    await eventually(() => text().includes(t().pairingTooMany));
    // Once they expire, by the server's clock, a code is given again.
    server.now += 300;
    await showCode();
    click(".home-change-key");
    await eventually(() => text().includes(t().keyChanged));
    expect($(".home-pairing")).toBeNull();
    a.view.close();
  });
});
