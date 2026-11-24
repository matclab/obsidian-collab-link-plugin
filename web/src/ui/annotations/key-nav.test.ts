// @vitest-environment jsdom
//
// The key brought forward, in the bar (ADR-0051 §4; phase 25c): nothing
// until a key is chosen; then the key's start, how many annotations it signed,
// ‹ › from one to the next in the text's order, × back to the usual view.
import { LoroDoc } from "loro-crdt";
import { flushSync } from "svelte";
import { describe, expect, test } from "vitest";
import {
  AnnotationIndex,
  DecisionLog,
  createAnnotation,
} from "../../../lib/src/index.js";
import { t } from "../../i18n/index.js";
import { ActiveAnnotation } from "../../view-model/active-annotation.js";
import { attachKeyNav } from "./key-nav.js";
import { SignerKeys } from "./signer-keys.svelte.js";

const KEY = { fingerprint: "ab".repeat(32), short: "abab abab abab abab" };

function setUp() {
  const contentDoc = new LoroDoc();
  contentDoc.getText("content").insert(0, "one two three four five");
  contentDoc.commit();
  const annotationsDoc = new LoroDoc();
  const index = new AnnotationIndex(
    contentDoc,
    annotationsDoc,
    new DecisionLog(),
  );
  const comment = (start: number) =>
    createAnnotation(contentDoc, annotationsDoc, {
      type: "comment",
      start,
      end: start + 3,
      author: "Alice",
      body: "?",
    });
  const host = document.createElement("div");
  document.body.append(host);
  const keys = new SignerKeys();
  const active = new ActiveAnnotation();
  const nav = attachKeyNav(host, { keys, index, active });
  const button = (name: string) =>
    host.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`);
  return { keys, active, host, nav, comment, button };
}

describe("the key brought forward, in the bar", () => {
  test("nothing until a key is chosen", () => {
    const s = setUp();
    expect(s.host.querySelector(".key-nav")).toBeNull();
    s.nav.destroy();
  });

  test("the key, how many it signed; ‹ › in the text's order, around", () => {
    const s = setUp();
    // Created, and listed, out of the text's order.
    const late = s.comment(16);
    const early = s.comment(0);
    const middle = s.comment(8);
    s.keys.signed = new Map([[KEY.fingerprint, [late, early, middle]]]);
    s.keys.chosen = KEY;
    flushSync();
    const nav = s.host.querySelector(".key-nav");
    // Its start, to fit the bar; the whole of it in the label.
    expect(nav?.textContent).toContain(KEY.short.slice(0, 4));
    expect(nav?.textContent).toContain("3");
    expect(nav?.getAttribute("aria-label")).toBe(
      t().keyBroughtForward(KEY.short, 3),
    );
    s.button(t().nextOfKey)?.click();
    expect(s.active.id).toBe(early);
    s.button(t().nextOfKey)?.click();
    expect(s.active.id).toBe(middle);
    s.button(t().nextOfKey)?.click();
    s.button(t().nextOfKey)?.click();
    expect(s.active.id).toBe(early);
    s.button(t().previousOfKey)?.click();
    expect(s.active.id).toBe(late);
    s.nav.destroy();
  });

  test("× back to the usual view", () => {
    const s = setUp();
    s.keys.chosen = KEY;
    flushSync();
    s.button(t().stopBringingForward)?.click();
    expect(s.keys.chosen).toBeUndefined();
    expect(s.host.querySelector(".key-nav")).toBeNull();
    s.nav.destroy();
  });
});
