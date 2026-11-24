// @vitest-environment jsdom
// The document menu (phase 38c): its sections in their order, each given
// to the part that fills it; the parts it holds itself.
import { describe, expect, test } from "vitest";
import { setLanguage, t } from "../i18n/index.js";
import type { IdentityKeys } from "../identity/identity-keys.js";
import { VERSION } from "../version.js";
import { OwnSignature } from "../view-model/own-signature.svelte.js";
import { createDocumentMenu } from "./view-menu.js";

function menuOf(options: {
  role: "edit" | "suggest" | "read";
  alerts: boolean;
  identity?: IdentityKeys;
}) {
  setLanguage("en");
  const body = document.createElement("div");
  const own = new OwnSignature();
  let helped = 0;
  let closed = 0;
  const stops: (() => void)[] = [];
  const menu = createDocumentMenu(body, {
    role: options.role,
    help: {
      open: () => {
        helped += 1;
      },
    },
    close: () => {
      closed += 1;
    },
    alerts: options.alerts,
    own,
    identity: options.identity,
    copy: async () => {},
    storage: undefined,
    reload: () => {},
    stops,
  });
  return { body, menu, own, stops, helped: () => helped, closed: () => closed };
}

describe("the document menu", () => {
  test("an edit link's: files, help, kept, expiry, identity, alerts, signing key, name, language, deleting, then the version", () => {
    const { body, menu } = menuOf({ role: "edit", alerts: true });
    const sections = Array.from(body.children);
    const at = (element: Element | undefined) =>
      element ? sections.indexOf(element) : -1;
    const order = [
      at(menu.files),
      at(body.querySelector(".open-writing-help")?.parentElement ?? undefined),
      at(menu.kept),
      at(menu.expiry),
      at(menu.identity),
      at(menu.alerts),
      at(body.querySelector(".signing-key") ?? undefined),
      at(menu.name),
      at(menu.name.nextElementSibling ?? undefined),
      at(menu.danger),
    ];
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(sections.at(-1)?.textContent).toBe(t().appVersion(VERSION));
  });

  test("a read link's: no help, no notifications asked, no signing key", () => {
    const { body, menu } = menuOf({ role: "read", alerts: false });
    expect(body.querySelector(".open-writing-help")).toBeNull();
    expect(body.querySelector(".signing-key")).toBeNull();
    expect(menu.alerts).toBeUndefined();
  });

  test("the help's entry closes the menu and opens the help", () => {
    const { body, helped, closed } = menuOf({ role: "edit", alerts: false });
    body.querySelector<HTMLButtonElement>(".open-writing-help")?.click();
    expect([closed(), helped()]).toEqual([1, 1]);
  });

  test("opened, the signing key is asked for; a read link draws none", async () => {
    let drawn = 0;
    const identity = {
      signer: async () => {
        drawn += 1;
        return { fingerprint: new Uint8Array(32).fill(7) };
      },
    } as unknown as IdentityKeys;
    const edit = menuOf({ role: "edit", alerts: false, identity });
    edit.menu.opened();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(edit.own.short).toBeDefined();
    const read = menuOf({ role: "read", alerts: false, identity });
    read.menu.opened();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(drawn).toBe(1);
    expect(read.own.short).toBeUndefined();
  });
});
