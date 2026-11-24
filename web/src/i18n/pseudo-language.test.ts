import { forceParsing } from "@codemirror/language";
import { StateEffect } from "@codemirror/state";
import { LoroDoc } from "loro-crdt";
import { flushSync, mount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createAnnotation,
  suggestAddition,
} from "../../lib/src/annotations/index.js";
import { registerPeers } from "../../lib/src/history/tables.js";
import { CloseCode } from "../../lib/src/index.js";
import { forwardSignInReturn } from "../account/auth-return.js";
import { localStatusMessage, refusalMessage } from "../app/messages.js";
import { wireClient } from "../app/wire-client.js";
import { createDocumentEditor } from "../editor/editor.js";
import { firstHints } from "../editor/first-hints.js";
import { withoutLayout } from "../editor/test-support/no-layout.js";
import Home from "../keyring/Home.svelte";
// @vitest-environment jsdom
//
// No text of the interface bypasses the dictionary (phase 10, decision 3):
// the page is mounted in a pseudo-language that marks every text of the
// dictionary ⟦like this⟧. Once the marked texts and the test's own data
// (names, the document, links) are taken out, no word may remain.
import type { AccountOffer } from "../keyring/home.js";
import { createAlertsInvite } from "../ui/alerts/alerts-invite-view.js";
import { createAlertsSetting } from "../ui/alerts/alerts-setting.js";
import type { AlertPermission } from "../ui/alerts/alerts.js";
import { NotificationOffer } from "../ui/alerts/notification-offer.js";
import { askName } from "../ui/dialogs/name-dialog.js";
import { createNotices } from "../ui/dialogs/notices.js";
import { createSignToNameDialog } from "../ui/dialogs/sign-to-name-dialog.js";
import IdentityLineView from "../ui/header/IdentityLine.svelte";
import { createHeader } from "../ui/header/header.js";
import { createHereNow } from "../ui/header/here-now.js";
import type { IdentityLine } from "../ui/header/identity-line.js";
import { createDocumentLifecycle } from "../ui/menu/document-lifecycle.js";
import { createKeptField } from "../ui/menu/kept-field.js";
import { createLanguageField } from "../ui/menu/language-field.js";
import { createPseudonymField } from "../ui/menu/pseudonym-field.js";
import { createSharePanel } from "../ui/menu/share-panel.js";
import { createWelcome } from "../ui/writing/welcome.js";
import { createWritingHelp } from "../ui/writing/writing-help.js";
import { type Dictionary, en } from "./en.js";
import { setLanguage, t, useDictionary } from "./index.js";

// The formatting toolbar's buttons scroll the editor (phase 20).
const destroyed = withoutLayout();

function pseudo(dictionary: Dictionary): Dictionary {
  return Object.fromEntries(
    Object.entries(dictionary).map(([key, value]) => [
      key,
      typeof value === "function"
        ? (...args: unknown[]) =>
            `⟦${(value as (...a: unknown[]) => string)(...args)}⟧`
        : `⟦${value}⟧`,
    ]),
  ) as Dictionary;
}

const LINKS = {
  read: "https://h/?doc=d#k=K&r=read.R",
  suggest: "https://h/?doc=d#k=K&r=suggest.S",
  edit: "https://h/?doc=d#k=K&r=edit.E",
};

/** What is left of `text` once marked texts and `data` are taken out:
 * empty, or without a word, when nothing bypassed the dictionary. */
function leftover(text: string, data: readonly string[]): string {
  let rest = text;
  for (let before = ""; before !== rest; ) {
    before = rest;
    rest = rest.replace(/⟦[^⟦⟧]*⟧/g, " ");
  }
  for (const value of data) rest = rest.split(value).join(" ");
  // Numbers and dates are data too (formatted by the language's Intl).
  rest = rest.replace(/\d+/g, " ").replace(/\b(AM|PM)\b/g, " ");
  return /\p{L}{2,}/u.test(rest) ? rest.trim() : "";
}

/** The document's own text and rendering: data, not interface (the
 * writing help's examples, rendered as the preview, are `.preview` too:
 * their source is checked in the cell beside). */
const DOCUMENT = ".cm-content, .preview, .history-changes pre";
const ATTRIBUTES = ["placeholder", "title", "aria-label"];

function bypasses(root: Element, data: readonly string[]): string[] {
  const found: string[] = [];
  for (const element of [root, ...Array.from(root.querySelectorAll("*"))]) {
    if (element.closest(DOCUMENT)) continue;
    for (const node of Array.from(element.childNodes)) {
      if (node.nodeType !== Node.TEXT_NODE) continue;
      const rest = leftover(node.textContent ?? "", data);
      if (rest) found.push(`<${element.tagName.toLowerCase()}> ${rest}`);
    }
    for (const name of ATTRIBUTES) {
      const value = element.getAttribute(name);
      const rest = value === null ? "" : leftover(value, data);
      if (rest) found.push(`[${name}] ${rest}`);
    }
  }
  return found;
}

beforeEach(() => {
  useDictionary(pseudo(en));
  // Exporting saves a file through a blob URL, which vitest's jsdom cannot
  // make (its shim fails on Node's Blob): this test reads the texts, not
  // the file.
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => {
  setLanguage("en");
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("in a pseudo-language, every text of the interface comes from the dictionary", () => {
  test("the editor, its views, the files and the annotations panel", () => {
    const contentDoc = new LoroDoc();
    const annotationsDoc = new LoroDoc();
    contentDoc.getText("content").insert(0, "hello world");
    contentDoc.commit();
    createAnnotation(contentDoc, annotationsDoc, {
      type: "deletion",
      start: 0,
      end: 5,
      author: "bob",
    });
    createAnnotation(contentDoc, annotationsDoc, {
      type: "comment",
      start: 6,
      end: 11,
      author: "bob",
      body: "a remark",
    });
    suggestAddition(contentDoc, annotationsDoc, {
      at: 11,
      text: "!",
      author: "bob",
      note: "a reason",
    });
    const editorParent = document.createElement("div");
    const panelParent = document.createElement("div");
    document.body.append(editorParent, panelParent);
    const client = wireClient({
      contentDoc,
      annotationsDoc,
      editorParent,
      panelParent,
      author: () => "alice",
      documentId: "doc",
      publishDecision: () => {},
      role: "edit",
      confirm: () => false,
    });
    destroyed(client.editor.view);
    const data = ["hello", "world", "bob", "alice", "a remark", "a reason"];
    const check = () => expect(bypasses(document.body, data)).toEqual([]);
    check();

    // The writing help (phase 20d).
    createWritingHelp(document.body, { mac: false }).open();
    flushSync();
    check();

    // The formatting toolbar's insert menu, open (phase 20).
    client.views.bar
      .querySelector<HTMLButtonElement>(
        '.format-toolbar [aria-haspopup="menu"]',
      )
      ?.click();
    flushSync();
    expect(client.views.bar.querySelector('[role="menu"]')).not.toBeNull();
    check();

    // The selection toolbar, then its composer and an error in it.
    client.editor.view.focus();
    client.editor.view.dispatch({ selection: { anchor: 0, head: 5 } });
    flushSync();
    check();
    for (const label of ["⟦Suggest⟧", "⟦Comment⟧"]) {
      Array.from(
        editorParent.querySelectorAll<HTMLButtonElement>(
          ".selection-toolbar button",
        ),
      )
        .find((button) => button.textContent?.trim() === label)
        ?.click();
      flushSync();
      check();
    }
    Array.from(
      editorParent.querySelectorAll<HTMLButtonElement>(
        ".selection-toolbar .primary",
      ),
    )[0]?.click();
    flushSync();
    check();

    // An error from the creation form.
    const create = panelParent.querySelector<HTMLButtonElement>(
      ".create-annotation-button",
    );
    create?.click();
    flushSync();
    check();

    // Every view: source, preview (with its pending suggestions), history.
    const buttons = Array.from(
      client.views.bar.querySelectorAll<HTMLButtonElement>("button"),
    );
    for (const button of buttons) {
      button.click();
      flushSync();
      check();
    }
    const entry =
      editorParent.querySelector<HTMLButtonElement>(".history-entry");
    entry?.click();
    flushSync();
    check();
    for (const button of Array.from(
      editorParent.querySelectorAll<HTMLButtonElement>(
        ".history-actions button",
      ),
    ).slice(0, 2)) {
      button.click();
      flushSync();
      check();
    }
    // About a second alone; past the 5 s default under the whole suite's
    // load (phase 24: one more property file was enough).
  }, 20_000);

  test("who wrote: its switch and its legend, wide and narrow (ADR-0059)", async () => {
    const contentDoc = new LoroDoc();
    contentDoc.setRecordTimestamp(true);
    contentDoc.getText("content").insert(0, "hello world");
    contentDoc.commit();
    const annotationsDoc = new LoroDoc();
    registerPeers(annotationsDoc, [contentDoc.peerIdStr], "bob");
    const data = ["hello", "world", "bob"];
    for (const narrow of [false, true]) {
      const editorParent = document.createElement("div");
      const panelParent = document.createElement("div");
      document.body.append(editorParent, panelParent);
      const client = wireClient({
        contentDoc,
        annotationsDoc,
        editorParent,
        panelParent,
        author: () => "bob",
        documentId: "doc",
        publishDecision: () => {},
        role: "edit",
        confirm: () => false,
        margin: {
          workspace: document.createElement("div"),
          keys: document.body,
          narrow: { matches: () => narrow, onChange: () => {} },
        },
      });
      destroyed(client.editor.view);
      client.editor.view.dispatch({ selection: { anchor: 3 } });
      client.authorship.toggle.click();
      // Every microtask run, however long its chain: a macrotask comes after.
      await new Promise((resolve) => setTimeout(resolve, 0));
      flushSync();
      editorParent
        .querySelector<HTMLButtonElement>(".authorship-legend [aria-expanded]")
        ?.click();
      flushSync();
      expect(
        editorParent.querySelector(".authorship-legend")?.textContent,
      ).toContain("bob");
      expect(bypasses(document.body, data)).toEqual([]);
      document.body.replaceChildren();
    }
  });

  test("a remote image: its banner, its case, waiting, granted (ADR-0055)", () => {
    const contentDoc = new LoroDoc();
    contentDoc
      .getText("content")
      .insert(0, "hello\n\n![a map](https://img.example/a.png)\n");
    contentDoc.commit();
    const editorParent = document.createElement("div");
    const panelParent = document.createElement("div");
    document.body.append(editorParent, panelParent);
    const client = wireClient({
      contentDoc,
      annotationsDoc: new LoroDoc(),
      editorParent,
      panelParent,
      author: () => "alice",
      documentId: "doc",
      publishDecision: () => {},
      role: "read",
      confirm: () => false,
    });
    destroyed(client.editor.view);
    flushSync();
    const data = ["hello", "a map", "img.example"];
    const check = () => expect(bypasses(document.body, data)).toEqual([]);
    expect(editorParent.querySelector(".remote-images-banner")).not.toBeNull();
    expect(
      editorParent.querySelector(".remote-image-case button"),
    ).not.toBeNull();
    check();
    // Under the caret, granted: it waits.
    client.editor.view.dispatch({ selection: { anchor: 9 } });
    editorParent
      .querySelector<HTMLButtonElement>(".remote-images-banner button")
      ?.click();
    flushSync();
    expect(editorParent.querySelector(".remote-image-waiting")).not.toBeNull();
    expect(editorParent.querySelector(".remote-images-granted")).not.toBeNull();
    check();
    client.editor.view.dispatch({ selection: { anchor: 0 } });
    flushSync();
    expect(editorParent.querySelector(".remote-image-from")).not.toBeNull();
    check();
  });

  test("sharing, the lifecycle, the name, who is here", () => {
    const root = document.createElement("div");
    document.body.append(root);
    createSharePanel(root, {
      role: "edit",
      links: LINKS,
      onRenew: async () => {},
      confirm: () => false,
      copy: async () => {},
    });
    createDocumentLifecycle(root, {
      role: "edit",
      expiresAt: Date.now() / 1000 + 3 * 24 * 3600,
      now: () => Date.now(),
      confirm: () => false,
      setExpiry: async (s) => s,
      deleteDocument: () => {},
    });
    createPseudonymField(root, {
      name: "alice",
      save: () => undefined,
      onRenamed: () => {},
    });
    // Signed in: the identity's name, and its note.
    createPseudonymField(root, {
      name: "alice",
      save: () => undefined,
      onRenamed: () => {},
    }).show("alice", true);
    createHereNow(root, { others: () => [], subscribe: () => () => {} });
    createLanguageField(root, { storage: undefined, reload: () => {} });
    // Each language is named in itself.
    const data = ["alice", ...Object.values(LINKS), "English", "Français"];
    expect(bypasses(root, data)).toEqual([]);
    const name = root.querySelector<HTMLInputElement>(".pseudonym-input");
    if (name) name.value = " ";
    root.querySelector<HTMLButtonElement>(".pseudonym-save")?.click();
    root.querySelector<HTMLButtonElement>(".copy-read")?.click();
    flushSync();
    expect(bypasses(root, data)).toEqual([]);
  });

  test("the header, for each role and each state of the changes", () => {
    for (const role of ["edit", "suggest", "read"] as const) {
      const root = document.createElement("div");
      document.body.append(root);
      const header = createHeader(root, {
        role,
        onShare: () => {},
        onDocument: () => {},
      });
      expect(bypasses(root, [])).toEqual([]);
      for (const state of ["saved", "sending", "offline"] as const) {
        header.setSync(state);
        expect(bypasses(root, [])).toEqual([]);
      }
      header.setTitle("hello");
      expect(bypasses(root, ["hello"])).toEqual([]);
      // The identity chip (analysis 18o.3, IC5).
      for (const chip of [
        "confirm",
        "unconfirmed",
        "associate",
        "open-here",
        "other",
        "sign-in",
        "pending",
      ] as const) {
        header.setIdentity(chip);
        expect(bypasses(root, ["hello"])).toEqual([]);
      }
    }
  });

  test("the question before signing, signed out and signed in (18o.3, IC4)", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const dialog = createSignToNameDialog(root, () => undefined, {
      homeHref: "/",
      reason: () => t().identityOther,
    });
    for (const view of [
      "asking",
      "pending",
      "confirm",
      "unconfirmed",
      "home",
    ] as const) {
      dialog.show(view);
      expect(bypasses(root, []), view).toEqual([]);
    }
  });

  test("the notifications of the document menu, in each state (ADR-0060)", () => {
    for (const permission of ["default", "granted", "denied"] as const) {
      const root = document.createElement("div");
      document.body.append(root);
      createAlertsSetting(
        root,
        new NotificationOffer(
          {
            permission: () => permission,
            request: async (): Promise<AlertPermission> => permission,
          },
          undefined,
        ),
      );
      expect(bypasses(root, []), permission).toEqual([]);
    }
  });

  test("this device's notifications, in each state (ADR-0060 §4)", async () => {
    // Each state, then each outcome of a subscription, said with it.
    for (const [state, outcome] of [
      ["on", undefined],
      ["off", undefined],
      ["off", "no-key"],
      ["on", "refused"],
    ] as const) {
      const root = document.createElement("div");
      document.body.append(root);
      const control = {
        state: async () => state,
        enable: async () => outcome,
        disable: async () => "off" as const,
      };
      const offer = new NotificationOffer(
        undefined,
        Promise.resolve(control as never),
      );
      createAlertsSetting(root, offer);
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (outcome) await offer.setDevice(true);
      expect(offer.attempt()).toBe(outcome ?? "idle");
      expect(bypasses(root, []), `${state} ${outcome}`).toEqual([]);
    }
  });

  test("the invitation to be notified, with and without this device (phase 34j)", async () => {
    for (const control of [
      {
        state: async () => "off" as const,
        enable: async () => "on" as const,
        disable: async () => "off" as const,
      },
      undefined,
    ]) {
      const root = document.createElement("div");
      document.body.append(root);
      const offer = new NotificationOffer(
        {
          permission: () => "default",
          request: async (): Promise<AlertPermission> => "granted",
        },
        Promise.resolve(control as never),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      createAlertsInvite(root, {
        offer,
        documentId: "doc",
        storage: undefined,
        say: () => {},
      }).written();
      expect(root.querySelector(".alerts-invite")).not.toBeNull();
      expect(bypasses(root, []), String(control)).toEqual([]);
    }
  });

  test("the first visit's banner, for a writer and a suggester (phase 37g)", () => {
    for (const role of ["edit", "suggest"] as const) {
      const root = document.createElement("div");
      document.body.append(root);
      createWelcome(root, { role, storage: undefined, onHelp: () => {} });
      expect(root.querySelector(".welcome"), role).not.toBeNull();
      expect(bypasses(root, []), role).toEqual([]);
    }
  });

  test("the first hints, the markup's and the diagram's (phase 37h)", () => {
    const text = "# T\n```mermaid\nflowchart LR\n```";
    for (const [line, data] of [
      [1, []],
      [3, []],
    ] as const) {
      const doc = new LoroDoc();
      doc.getText("content").insert(0, text);
      doc.commit();
      const root = document.createElement("div");
      document.body.append(root);
      const { view } = createDocumentEditor(root, doc, { livePreview: true });
      destroyed(view);
      forceParsing(view, view.state.doc.length, 5000);
      view.dispatch({
        effects: StateEffect.appendConfig.of(
          firstHints({
            seen: new Set(line === 1 ? [] : ["markup"]),
            remember: () => {},
            toReading: () => {},
          }),
        ),
      });
      view.dispatch({
        selection: { anchor: view.state.doc.line(line).from },
        userEvent: "select",
      });
      const hint = root.querySelector(".first-hint");
      expect(hint, String(line)).not.toBeNull();
      expect(bypasses(hint as Element, data), String(line)).toEqual([]);
    }
  });

  test("the first name's dialog, and a notice with its action", () => {
    void askName(document.body);
    const root = document.createElement("div");
    document.body.append(root);
    createNotices(root).show("text", {
      label: t().reload,
      run: () => {},
    });
    // The notice's own text is the test's: only its buttons are checked.
    const notice = root.querySelector(".notice-text");
    notice?.remove();
    expect(bypasses(document.body, [])).toEqual([]);
  });

  test("what the page says when the connection is refused or nothing is kept", () => {
    const codes = [
      CloseCode.Unauthenticated,
      CloseCode.Deleted,
      CloseCode.Revoked,
      CloseCode.Forbidden,
      CloseCode.UnsupportedVersion,
      4999,
    ];
    for (const code of codes)
      expect(leftover(refusalMessage(code), [])).toBe("");
    for (const status of ["other-tab", "unreadable", "unavailable"] as const) {
      expect(leftover(localStatusMessage(status) ?? "", [])).toBe("");
    }
  });

  test("the home and « Mes documents », in each of their states", async () => {
    const entries = [
      {
        documentId: "d1",
        state: "ok",
        role: "edit",
        link: "https://h/?doc=d1#k=K&r=edit.E",
        title: "Plan",
        openedAt: 1_792_159_267_897,
        createdHere: true,
        excluded: false,
      },
      {
        documentId: "d2",
        state: "renewed",
        role: "read",
        link: "https://h/?doc=d2#k=K&r=read.R",
        title: null,
        openedAt: null,
        createdHere: false,
        excluded: false,
      },
      {
        documentId: "d3",
        state: "deleted",
        role: "suggest",
        link: "https://h/?doc=d3#k=K&r=suggest.S",
        title: "Old",
        openedAt: 5,
        createdHere: false,
        excluded: false,
      },
    ] as const;
    const data = [
      "Plan",
      "Old",
      "oc-keyring:v1:key",
      "https://collab.test/?pair=p#p=k",
    ];
    const props = {
      newDocumentHref: "?new",
      onKeep: () => {},
      onFind: () => {},
      onRemove: () => {},
      onNewLink: () => {},
      onRecreate: () => {},
      onShowKey: () => {},
      onChangeKey: () => {},
      onNewKey: () => {},
      onCopy: () => {},
      onAddDevice: () => {},
      onPairingDone: () => {},
      onSignIn: () => {},
      onCancelSignIn: () => {},
      onSignOut: () => {},
      onAttach: () => {},
      onAccountKey: () => {},
      onLater: () => {},
      onAssociateOther: () => {},
      onForgetOther: () => {},
      onConfirmIdentity: () => {},
      onRetryIdentity: () => {},
      onNewSigningKey: () => {},
      onStartOver: () => {},
    };
    for (const available of [false, true]) {
      document.body.replaceChildren();
      const home = mount(Home, {
        target: document.body,
        props: { ...props, available },
      });
      flushSync();
      expect(bypasses(document.body, data)).toEqual([]);
      if (!available) continue;
      home.setFindError(t().keyInvalid);
      home.say(t().keyringGone, true);
      flushSync();
      expect(bypasses(document.body, data)).toEqual([]);
      home.setKeyring(true, []);
      flushSync();
      expect(bypasses(document.body, data)).toEqual([]);
      home.setKeyring(
        true,
        entries.map((e) => ({ ...e })),
      );
      home.reveal("oc-keyring:v1:key");
      home.setNewLinkError("d2", t().linkNotThisDocument);
      // What awaits my reply in a document (ADR-0060 §2).
      home.setAwaiting(entries[0]?.documentId ?? "", 2);
      flushSync();
      expect(bypasses(document.body, data)).toEqual([]);
      home.showPairing({
        address: "https://collab.test/?pair=p#p=k",
        path: "M4 4h1v1h-1z",
        size: 9,
      });
      flushSync();
      expect(bypasses(document.body, data)).toEqual([]);
      home.pairingExpired();
      flushSync();
      expect(bypasses(document.body, data)).toEqual([]);
      // The list and the identity (analyses 18i.3, 18o.2): the titles are
      // the list's, not the page's.
      const identity = t().yourIdentity(
        "Org",
        t().identityWho("Ada", "ada@example.org"),
      );
      const offers: AccountOffer[] = [
        { kind: "ask", count: 7, titles: [], later: false },
        { kind: "ask", count: 2, titles: [], later: true },
        { kind: "needs-key" },
        { kind: "other", count: 3, titles: [], name: "Ada" },
        { kind: "other", count: 1, titles: [] },
      ];
      for (const offer of offers) {
        home.setAccountList(offer, false, identity);
        home.setAccountKeyError(t().accountKeyWrong);
        flushSync();
        expect(bypasses(document.body, data)).toEqual([]);
      }
      home.setAccountList({ kind: "none" }, true, identity);
      // The account (analysis 18i.2), in each of its states.
      for (const state of [
        { kind: "signed-out", ready: true },
        { kind: "signed-out", ready: true, reason: "denied" },
        { kind: "signed-out", ready: true, reason: "failed" },
        { kind: "signed-out", ready: true, reason: "expired" },
        { kind: "pending" },
        {
          kind: "signed-in",
          name: "Ada",
          email: "ada@example.org",
          issuer: "i",
          sub: "s",
        },
      ] as const) {
        home.setAccount(state);
        flushSync();
        expect(
          bypasses(document.body, [...data, "Ada", "ada@example.org"]),
        ).toEqual([]);
      }
      // The step left (analysis 18o.3, IC3), signed in.
      for (const step of ["confirm", "unconfirmed", "refused"] as const) {
        home.setIdentityStep(step);
        flushSync();
        expect(
          bypasses(document.body, [...data, "Ada", "ada@example.org"]),
        ).toEqual([]);
      }
      // Phase 30: the new key's replacement found offline.
      home.setNewSigningKeyOffline(true);
      flushSync();
      expect(
        bypasses(document.body, [...data, "Ada", "ada@example.org"]),
      ).toEqual([]);
      home.setNewSigningKeyOffline(false);
      home.setIdentityStep(undefined);
    }
    document.body.replaceChildren();
    forwardSignInReturn({
      hash: "",
      pathname: "/auth-return",
      replaceAddress: () => {},
      post: () => {},
      close: () => {},
      say: (text) => {
        const said = document.createElement("p");
        said.textContent = text;
        document.body.append(said);
      },
    });
    expect(bypasses(document.body, [])).toEqual([]);
    document.body.replaceChildren();
    createKeptField(document.body, {
      isKept: async () => true,
      setKept: async () => {},
    });
    await Promise.resolve();
    flushSync();
    expect(bypasses(document.body, [])).toEqual([]);
  });

  // Analysis 18o.2: the identity line, in each of its states; the
  // person's name and address are the provider's, not the page's.
  test("the identity line of the document menu", () => {
    const data = ["Ada Lovelace (ada@example.org)", "Org"];
    for (const line of [
      { kind: "sign-in", ready: true },
      { kind: "pending" },
      { kind: "attested", org: "Org", who: data[0] },
      { kind: "associate", who: data[0] },
      { kind: "open-here", who: data[0] },
      { kind: "other", who: data[0] },
      { kind: "confirm", who: data[0] },
      { kind: "refused", who: data[0] },
      { kind: "refused", who: data[0], replacing: "offline" },
      { kind: "unconfirmed", who: data[0] },
      { kind: "signed-in", who: data[0] },
    ] as IdentityLine[]) {
      document.body.replaceChildren();
      const view = mount(IdentityLineView, {
        target: document.body,
        props: {
          homeHref: "/",
          onSignIn: () => {},
          onConfirm: () => {},
          onCancel: () => {},
          onRetry: () => {},
          onNewKey: () => {},
        },
      });
      view.show(line, "Org");
      flushSync();
      expect(bypasses(document.body, data), line.kind).toEqual([]);
    }
  });
});
