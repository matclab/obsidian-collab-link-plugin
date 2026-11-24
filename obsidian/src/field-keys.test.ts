// @vitest-environment jsdom
// Ctrl+Enter sends an annotation's text (the composer, a reply); in
// Obsidian, its keymap took it first for its own commands, and the field
// never saw it (docs/bugs.md, checked in the real Obsidian).
import type { Keymap, Scope as ObsidianScope } from "obsidian";
import { afterEach, describe, expect, test } from "vitest";
import { letFieldsTakeModEnter } from "./field-keys.js";
import { FakeApp, Scope } from "./test-support/obsidian.js";

afterEach(() => document.body.replaceChildren());

function setUp() {
  const app = new FakeApp();
  const root = document.createElement("div");
  root.innerHTML =
    '<textarea class="composer-text"></textarea><input class="composer-note"><textarea class="reply-text"></textarea><button>Send</button><div class="cm-content" contenteditable="true"></div>';
  document.body.append(root);
  const scope = new Scope(app.scope);
  const stop = letFieldsTakeModEnter(
    root,
    app.keymap as unknown as Keymap,
    scope as unknown as ObsidianScope,
  );
  const field = (selector: string) =>
    root.querySelector<HTMLElement>(selector) as HTMLElement;
  // Mod+Enter, as Obsidian's keymap reads it in the active scope: handled
  // (no command of its own), not prevented, so the field gets it.
  const modEnter = () => {
    const top = app.keymap.scopes.at(-1);
    const handler = top?.handlers.find(
      (h) => h.key === "Enter" && h.modifiers?.join() === "Mod",
    );
    return handler?.func(new KeyboardEvent("keydown"), {});
  };
  return { app, root, scope, stop, field, modEnter };
}

describe("letFieldsTakeModEnter", () => {
  test("in a text field, Mod+Enter is the field's: handled by the view's scope, not prevented", () => {
    const { app, scope, field, modEnter } = setUp();
    expect(app.keymap.scopes).toEqual([]);
    field(".composer-text").focus();
    expect(app.keymap.scopes).toEqual([scope]);
    // `false` would prevent it; `true` lets it on, no command run.
    expect(modEnter()).toBe(true);
    field(".composer-note").focus();
    expect(app.keymap.scopes).toEqual([scope]);
    field(".reply-text").focus();
    expect(app.keymap.scopes).toEqual([scope]);
  });

  test("out of the fields, Obsidian's own: the text, a button, elsewhere", () => {
    const { app, field } = setUp();
    field(".reply-text").focus();
    field("button").focus();
    expect(app.keymap.scopes).toEqual([]);
    field(".composer-text").focus();
    field(".cm-content").focus();
    expect(app.keymap.scopes).toEqual([]);
    field(".composer-text").focus();
    field(".composer-text").blur();
    expect(app.keymap.scopes).toEqual([]);
  });

  test("stopped, a field focused: its scope taken away, the focus no longer heard", () => {
    const { app, field, stop } = setUp();
    field(".composer-text").focus();
    stop();
    expect(app.keymap.scopes).toEqual([]);
    field("button").focus();
    field(".reply-text").focus();
    expect(app.keymap.scopes).toEqual([]);
  });
});
