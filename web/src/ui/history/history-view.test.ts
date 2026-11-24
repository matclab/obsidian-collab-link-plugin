// @vitest-environment jsdom
import { LoroDoc } from "loro-crdt";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Role } from "../../../lib/src/crypto/index.js";
import {
  listVersions,
  nameVersion,
  registerPeers,
} from "../../history/index.js";
import { counter, resetCounters } from "../../perf/index.js";
import { RENDER_DELAY_MS } from "../reading/preview.js";
import { createHistoryView } from "./history-view.js";

function type(doc: LoroDoc, at: number, insert: string): void {
  doc.setNextCommitTimestamp(at);
  const text = doc.getText("content");
  text.insert(text.length, insert);
  doc.commit();
}

function setUp(role: Role = "edit", confirmed = true) {
  const contentDoc = new LoroDoc();
  contentDoc.setPeerId(1n);
  contentDoc.setRecordTimestamp(true);
  contentDoc.setChangeMergeInterval(60); // as the page does
  const annotationsDoc = new LoroDoc();
  registerPeers(annotationsDoc, ["1"], "alice");
  type(contentDoc, 1000, "draft");
  type(contentDoc, 2000, " final");
  const parent = document.createElement("div");
  const confirm = vi.fn(() => confirmed);
  const history = createHistoryView(parent, {
    contentDoc,
    annotationsDoc,
    role,
    author: () => "me",
    confirm,
    now: () => 5_000_000,
    loaders: {
      katex: () => new Promise(() => {}),
      diagrams: () => new Promise(() => {}),
    },
  });
  const entries = () =>
    Array.from(parent.querySelectorAll<HTMLButtonElement>(".history-entry"));
  const button = (label: string) =>
    Array.from(parent.querySelectorAll("button")).find(
      (element) => element.textContent === label,
    );
  const select = (at: number) => entries()[at]?.click();
  const shownText = () =>
    parent.querySelector(".history-text .preview")?.textContent?.trim();
  /** A change from another peer, as an import. */
  const remoteEdit = (text: string) => {
    const remote = new LoroDoc();
    remote.setPeerId(2n);
    remote.import(contentDoc.export({ mode: "snapshot" }));
    type(remote, 3000, text);
    contentDoc.import(
      remote.export({ mode: "update", from: contentDoc.oplogVersion() }),
    );
  };
  return {
    contentDoc,
    annotationsDoc,
    parent,
    history,
    confirm,
    entries,
    button,
    select,
    shownText,
    remoteEdit,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetCounters();
});
afterEach(() => vi.useRealTimers());

describe("createHistoryView", () => {
  test("hidden, it costs nothing: no list, no fork, whatever changes", () => {
    const { contentDoc, remoteEdit, entries } = setUp();
    type(contentDoc, 2500, "!");
    remoteEdit("?");
    vi.advanceTimersByTime(10 * RENDER_DELAY_MS);
    expect(counter("history.list")).toBe(0);
    expect(counter("history.fork")).toBe(0);
    expect(entries()).toHaveLength(0);
  });

  test("shown: the versions newest first, the current one marked", () => {
    const { history, entries, parent } = setUp();
    history.show();
    expect(entries()).toHaveLength(2);
    expect(entries()[0]?.textContent).toContain("alice");
    expect(entries()[0]?.querySelector(".history-current")).not.toBeNull();
    expect(parent.textContent).toContain("not verified");
    expect(counter("history.list")).toBe(1);
  });

  test("shown: a burst of changes computes the list once, after a pause; hidden again, nothing", () => {
    const { history, remoteEdit, contentDoc } = setUp();
    history.show();
    resetCounters();
    remoteEdit("a");
    remoteEdit("b");
    type(contentDoc, 2600, "c");
    expect(counter("history.list")).toBe(0);
    vi.advanceTimersByTime(RENDER_DELAY_MS);
    expect(counter("history.list")).toBe(1);

    history.hide();
    resetCounters();
    remoteEdit("d");
    vi.advanceTimersByTime(10 * RENDER_DELAY_MS);
    expect(counter("history.list")).toBe(0);
  });

  test("a past version: its text rendered, or its changes since; one fork per showing", () => {
    const { history, select, shownText, button, parent } = setUp();
    history.show();
    expect(counter("history.fork")).toBe(0); // nothing selected yet
    select(1);
    expect(shownText()).toBe("draft");
    expect(counter("history.fork")).toBe(1);
    expect(parent.querySelector(".history-title")?.textContent).toContain(
      "alice",
    );

    button("Compare with the current text")?.click();
    expect(parent.querySelector(".history-summary")?.textContent).toBe(
      "What changed from this version until now: +1 word, −0 words",
    );
    expect(parent.querySelector(".history-changes ins")?.textContent).toBe(
      " final",
    );
    expect(parent.querySelector(".history-changes")?.textContent).toBe(
      "draft final",
    );
    expect(counter("history.fork")).toBe(2);
  });

  test("what each role may do", () => {
    const labels = (role: Role) => {
      const { history, select, parent } = setUp(role);
      history.show();
      select(1);
      return Array.from(parent.querySelectorAll(".history-actions button"))
        .map((element) => element.textContent)
        .filter(
          (label) =>
            label !== "Read this version" &&
            label !== "Compare with the current text",
        );
    };
    expect(labels("read")).toEqual([]);
    expect(labels("suggest")).toEqual(["Name this version"]);
    expect(labels("edit")).toEqual(["Name this version", "Put this text back"]);
  });

  test("names a version, then deletes the name", () => {
    const {
      history,
      select,
      parent,
      button,
      annotationsDoc,
      contentDoc,
      entries,
    } = setUp("suggest");
    history.show();
    select(1);
    const input = parent.querySelector<HTMLInputElement>(".history-name input");
    if (!input) throw new Error("no name field");
    input.value = "first draft";
    input.dispatchEvent(new Event("input"));
    flushSync();
    button("Name this version")?.click();
    const [named] = listVersions(annotationsDoc, contentDoc);
    expect(named).toMatchObject({
      name: "first draft",
      author: "me",
      at: 5_000_000,
    });
    expect(input.value).toBe(""); // cleared once named
    const namedRow = entries().find((row) => row.classList.contains("named"));
    expect(namedRow?.textContent).toContain("first draft");

    namedRow?.click();
    button("Delete this name")?.click();
    expect(listVersions(annotationsDoc, contentDoc)).toEqual([]);
  });

  test("restores a version's text once confirmed, as a new edit with a message", () => {
    const { history, select, button, contentDoc, confirm } = setUp("edit");
    history.show();
    select(1);
    button("Put this text back")?.click();
    expect(confirm).toHaveBeenCalledOnce();
    expect(contentDoc.getText("content").toString()).toBe("draft");
    const changes = contentDoc.getAllChanges().get(contentDoc.peerIdStr) ?? [];
    expect(changes.at(-1)?.message).toContain("Restored from");
  });

  test("restoring, cancelled: nothing changes", () => {
    const { history, select, button, contentDoc } = setUp("edit", false);
    history.show();
    select(1);
    button("Put this text back")?.click();
    expect(contentDoc.getText("content").toString()).toBe("draft final");
  });

  test("the current version has nothing to restore, nor to compare, and says why", () => {
    const { history, select, button, parent } = setUp("edit");
    history.show();
    select(0);
    expect(button("Put this text back")).toBeUndefined();
    const compare = button("Compare with the current text") as
      | HTMLButtonElement
      | undefined;
    expect(compare?.disabled).toBe(true);
    expect(parent.textContent).toContain(
      "This is the current version: nothing to compare.",
    );
  });

  test("a name whose text hasn't arrived says so, and offers no restore", () => {
    const { history, entries, parent, button, annotationsDoc } = setUp("edit");
    nameVersion(annotationsDoc, [{ peer: "99", counter: 5 }], {
      name: "elsewhere",
      author: "bob",
      at: 4_000_000,
    });
    history.show();
    entries()
      .find((row) => row.classList.contains("named"))
      ?.click();
    expect(parent.textContent).toContain("hasn't arrived yet");
    expect(button("Put this text back")).toBeUndefined();
    expect(counter("history.fork")).toBe(0);
  });
});

// Reported by the user (2026-10-16): what a click on a version does
// wasn't said. The list has a title; before a version is chosen, the view
// says what one can do with it, by role; putting a text back says what it
// does.
describe("what the history says it does", () => {
  const guide = (parent: Element) =>
    parent.querySelector(".history-guide")?.textContent?.trim();

  test("before a version is chosen: what one can do with one, by role", () => {
    for (const [role, expected] of [
      [
        "edit",
        "Choose a version: you can read it, compare it with the current text, name it, or put its text back.",
      ],
      [
        "suggest",
        "Choose a version: you can read it, compare it with the current text, or name it.",
      ],
      [
        "read",
        "Choose a version: you can read it or compare it with the current text.",
      ],
    ] as const) {
      const { parent, history, select } = setUp(role);
      history.show();
      flushSync();
      expect(guide(parent)).toBe(expected);
      select(0);
      expect(guide(parent)).toBeUndefined();
    }
  });

  test("its list has a title, then its note", () => {
    const { parent, history } = setUp();
    history.show();
    flushSync();
    const list = parent.querySelector(".history-list");
    expect(list?.querySelector("h2")?.textContent).toBe("Versions");
    expect(list?.querySelector("h2 + .history-note")).not.toBeNull();
  });

  test("putting a text back says what it does", () => {
    const { parent, history, select, entries } = setUp("edit");
    history.show();
    flushSync();
    select(entries().length - 1);
    expect(parent.querySelector(".history-restore-hint")?.textContent).toBe(
      "The current text becomes this version's, for everyone; the history keeps the one before.",
    );
  });
});

// Reported by the user (2026-10-16, a theme of their own): the "current"
// badge under its version's title came out of a button whose height a
// host or a theme sets, onto the next one. On the title's line, it stays in
// its own; an empty detail takes no line.
describe("the current version's badge", () => {
  test("on its version's title line, in its button only", () => {
    const { parent, history, entries } = setUp();
    history.show();
    flushSync();
    const badges = parent.querySelectorAll(".history-current");
    expect(badges).toHaveLength(1);
    const current = entries().find((entry) =>
      entry.querySelector(".history-current"),
    );
    expect(
      current?.querySelector(".history-title-row .history-current"),
    ).not.toBeNull();
    for (const entry of entries()) {
      const detail = entry.querySelector(".history-detail");
      if (detail) expect(detail.textContent?.trim()).not.toBe("");
    }
  });
});
