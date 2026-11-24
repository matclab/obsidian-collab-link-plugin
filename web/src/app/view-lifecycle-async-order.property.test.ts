// @vitest-environment jsdom
// The life of a view's link under a controlled order (AGENTS.md §1.6;
// phase 38c, LC1 – LC6): rotations accepted, the links of each computed
// in any order, the document deleted, the expiry learned, the view opened
// as `mountDocumentView` opens it (the share panel after its links, a
// rotation meanwhile shown again, then the menu's lifecycle section):
// each when Hegel says.
//
// At every step: the keyring learns only the current secret's links
// (LC2); the pending secret is gone once a rotation is accepted (LC3);
// the role's secret is the current one (LC6); open, the section has the
// last expiry (LC4) and, deleted, the editor is read-only (LC5). Once
// every link is computed, the panel shows the current secret's, renewed
// if a rotation was accepted (LC1).
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test, vi } from "vitest";
import {
  CloseCode,
  type Role,
  bytesToBase64Url,
  roleSecretHeader,
} from "../../lib/src/index.js";
import { setLanguage } from "../i18n/index.js";
import type { DocumentKeyring } from "../keyring/hooks.js";
import type { SharePanel } from "../ui/menu/share-panel.js";
import { followLifecycle } from "./view-lifecycle.js";

/** The menu's lifecycle section, as the view gives it what it learns. */
const sections = vi.hoisted(
  () =>
    [] as {
      expiresAt: number | null;
      expiries: (number | null)[];
      deleted: number;
    }[],
);
vi.mock("../ui/menu/document-lifecycle.js", () => ({
  createDocumentLifecycle: (
    _container: Element,
    options: { expiresAt: number | null },
  ) => {
    const section = {
      expiresAt: options.expiresAt,
      expiries: [] as (number | null)[],
      deleted: 0,
    };
    sections.push(section);
    return {
      setExpiry: (at: number | null) => section.expiries.push(at),
      deleted: () => {
        section.deleted += 1;
      },
      destroy: () => {},
    };
  },
}));

type TC = Parameters<Parameters<typeof hegel.testAsync>[0]>[0];

const quiet = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const DOC = "doc-1";
const linksFor = (secret: Uint8Array): Record<Role, string> => {
  const s = bytesToBase64Url(secret);
  return { edit: `e-${s}`, suggest: `c-${s}`, read: `r-${s}` };
};
const pendingKey = `oc:rotation:${DOC}`;

const lifecycleScenario = async (tc: TC): Promise<void> => {
  setLanguage("en");
  sections.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const withStorage = tc.draw(gs.booleans());
  const withKeyring = tc.draw(gs.booleans());
  const storage = withStorage ? window.localStorage : undefined;
  window.localStorage.clear();
  const initial = new Uint8Array([1]);
  if (storage && tc.draw(gs.booleans())) {
    storage.setItem(pendingKey, bytesToBase64Url(new Uint8Array([9])));
  }

  /** The links being computed, each resolved when Hegel says. */
  const computing: { secret: Uint8Array; resolve: () => void }[] = [];
  const told: string[] = [];
  let current = initial;
  const keyringOpened: string[] = [];
  /** What the keyring learned of another secret than the current (LC2). */
  const notCurrent: string[] = [];
  const keyring = withKeyring
    ? ({
        opened: async (link: string) => {
          if (link !== linksFor(current).edit) notCurrent.push(link);
          keyringOpened.push(link);
        },
        refused: async () => {},
      } as unknown as DocumentKeyring)
    : undefined;
  const notices: string[] = [];
  const lifecycle = followLifecycle({
    link: { key: "k", role: "edit", secret: initial },
    documentId: DOC,
    storage,
    keyring,
    documentLinks: (_base, _id, _key, secret) =>
      new Promise((resolve) => {
        computing.push({ secret, resolve: () => resolve(linksFor(secret)) });
      }),
    linkBase: () => "https://collab.test/",
    onEditLink: (links) => told.push(links.edit),
    confirm: () => true,
    showNotice: (text) => notices.push(text),
    unsent: () => 0,
  });

  /** The share panel's links, as set. */
  const panelLinks: { links: Record<Role, string>; renewed: boolean }[] = [];
  let panel: SharePanel | undefined;
  let rotations = 0;
  let deleted = false;
  let expiry: number | null = null;
  let opening = false;
  let open = false;
  let readOnly = 0;
  /** As `mountDocumentView`, once the document is open. */
  const openView = async () => {
    const shownSecret = lifecycle.editSecret();
    const links = shownSecret
      ? await lifecycle.linksOf(shownSecret)
      : undefined;
    if (links) panelLinks.push({ links, renewed: false });
    panel = {
      setLinks: (links: Record<Role, string>, renewed: boolean) =>
        panelLinks.push({ links, renewed }),
    } as unknown as SharePanel;
    const renewedMeanwhile = lifecycle.setSharePanel(panel);
    if (renewedMeanwhile) {
      const links = await lifecycle.linksOf(renewedMeanwhile);
      if (renewedMeanwhile === lifecycle.editSecret()) {
        panel.setLinks(links, true);
      }
    }
    lifecycle.opened({
      expiry: document.createElement("section"),
      danger: document.createElement("section"),
      connection: {
        setExpiry: async () => null,
        deleteDocument: () => {},
      },
      readOnly: () => {
        readOnly += 1;
      },
    });
    open = true;
  };

  const moves = ["renew", "links", "deleted", "expiry", "open"] as const;
  const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 30 }));
  for (let step = 0; step < steps; step++) {
    const move = tc.draw(gs.sampledFrom([...moves]));
    switch (move) {
      case "renew": {
        rotations += 1;
        current = new Uint8Array([1 + rotations]);
        void lifecycle.renewed(current);
        break;
      }
      case "links": {
        if (computing.length === 0) break;
        const at = tc.draw(
          gs.integers({ minValue: 0, maxValue: computing.length - 1 }),
        );
        computing.splice(at, 1)[0]?.resolve();
        break;
      }
      case "deleted":
        deleted = true;
        lifecycle.refused(CloseCode.Deleted);
        break;
      case "expiry":
        expiry = tc.draw(
          gs.sampledFrom([null, 1_000, 2_000] as (number | null)[]),
        );
        lifecycle.setExpiry(expiry);
        break;
      case "open":
        if (opening) break;
        opening = true;
        void openView();
        break;
    }
    await quiet();

    // LC2: the keyring learns only the current secret's links.
    expect(notCurrent).toEqual([]);
    // LC3: a rotation accepted, nothing pending any more.
    if (rotations > 0 && storage) {
      expect(storage.getItem(pendingKey)).toBeNull();
    }
    // LC6: the role's secret is the current one.
    expect(lifecycle.editSecret()).toEqual(current);
    expect(lifecycle.roleSecret()).toBe(roleSecretHeader("edit", current));
    expect(lifecycle.currentLink()).toContain(bytesToBase64Url(current));
    if (open) {
      const section = sections[0];
      expect(sections.length).toBe(1);
      // LC4: the last expiry learned, before or after the section.
      expect(
        section?.expiries.length ? section.expiries.at(-1) : section?.expiresAt,
      ).toBe(expiry);
      // LC5: deleted, read-only and said so; not deleted, neither.
      expect(readOnly > 0).toBe(deleted);
      expect((section?.deleted ?? 0) > 0).toBe(deleted);
    }
    // LC1: every link computed, the panel shows the current secret's.
    if (panel && computing.length === 0) {
      const last = panelLinks.at(-1);
      expect(last?.links).toEqual(linksFor(current));
      if (rotations > 0) expect(last?.renewed).toBe(true);
    }
  }
  // The host learns the current secret's links once computed (LC2).
  for (const pending of computing.splice(0)) pending.resolve();
  await quiet();
  if (rotations > 0) {
    expect(told.at(-1)).toBe(linksFor(current).edit);
    if (withKeyring) expect(keyringOpened.at(-1)).toBe(linksFor(current).edit);
  }
};

describe("the life of a view's link under a controlled order", () => {
  test(
    "LC1 – LC6 at every step, whatever the order",
    () =>
      hegel.testAsync(
        async (tc) => {
          // `console.warn`'s spy restored even when a case fails.
          try {
            await lifecycleScenario(tc);
          } finally {
            vi.restoreAllMocks();
          }
        },
        { testCases: 400 },
      ),
    600_000,
  );
});
