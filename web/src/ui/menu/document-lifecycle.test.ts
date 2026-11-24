// @vitest-environment jsdom
// The document's lifecycle section (ADR-0023, ADR-0024): its expiry shown
// to every role; for an editor, setting it by duration or by date (each
// confirmed), removing it, deleting the document.
import { flushSync } from "svelte";
import { describe, expect, test } from "vitest";
import type { Role } from "../../../lib/src/crypto/index.js";
import { formatDate } from "../../i18n/index.js";
import {
  createDocumentLifecycle,
  describeExpiry,
} from "./document-lifecycle.js";

const NOW_MS = Date.UTC(2026, 9, 1, 12, 0, 0);
const NOW = NOW_MS / 1000;
const DAY = 24 * 60 * 60;

function setUp(
  role: Role,
  options: {
    expiresAt?: number | null;
    confirmed?: boolean;
    connected?: boolean;
    reply?: "server" | "drop";
  } = {},
) {
  const container = document.createElement("div");
  const requests: (number | null)[] = [];
  const confirmations: string[] = [];
  let deletions = 0;
  const lifecycle = createDocumentLifecycle(container, {
    role,
    expiresAt: options.expiresAt ?? null,
    now: () => NOW_MS,
    confirm: (message) => {
      confirmations.push(message);
      return options.confirmed ?? true;
    },
    setExpiry: async (inSeconds) => {
      if (options.connected === false) throw new Error("not connected");
      requests.push(inSeconds);
      if (options.reply === "drop") throw new Error("outcome unknown");
      return inSeconds === null ? null : NOW + inSeconds;
    },
    deleteDocument: () => {
      if (options.connected === false) throw new Error("not connected");
      deletions++;
    },
  });
  const find = (selector: string) =>
    container.querySelector(selector) as HTMLInputElement | null;
  const click = async (selector: string) => {
    const element = find(selector);
    if (!element) throw new Error(`no ${selector}`);
    element.click();
    flushSync();
    // Let the request settle, then render.
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
  };
  const fill = (selector: string, value: string) => {
    const element = find(selector);
    if (!element) throw new Error(`no ${selector}`);
    element.value = value;
  };
  const type = (selector: string, value: string) => {
    fill(selector, value);
    find(selector)?.dispatchEvent(new Event("input"));
    flushSync();
  };
  return {
    container,
    lifecycle,
    type,
    requests,
    confirmations,
    deletions: () => deletions,
    find,
    click,
    fill,
    text: () => container.textContent ?? "",
  };
}

describe("describeExpiry", () => {
  test("says when, in local time, and how far", () => {
    expect(describeExpiry(null, NOW_MS)).toBe(
      "Kept until an editor deletes it.",
    );
    const at = NOW + 3 * DAY;
    expect(describeExpiry(at, NOW_MS)).toBe(
      `Deleted from the server on ${formatDate(at * 1000)} (in 3 days).`,
    );
    expect(describeExpiry(NOW + 5 * 3600, NOW_MS)).toContain("(in 5 hours)");
    expect(describeExpiry(NOW + 90, NOW_MS)).toContain("(in 2 minutes)");
    expect(describeExpiry(NOW + 30, NOW_MS)).toContain("(in 1 minute)");
    expect(describeExpiry(NOW - 10, NOW_MS)).toContain("(due)");
  });
});

describe("lifecycle section", () => {
  test("every role sees the expiry; only an editor gets the controls", () => {
    for (const role of ["read", "suggest"] as const) {
      const { text, find } = setUp(role, { expiresAt: NOW + DAY });
      expect(text()).toContain("(in 1 day)");
      expect(find(".expire-in-set")).toBeNull();
      expect(find(".delete-document")).toBeNull();
    }
    const editor = setUp("edit");
    expect(editor.text()).toContain("Kept until an editor deletes it.");
    expect(editor.find(".expire-in-set")).not.toBeNull();
    expect(editor.find(".expire-on-set")).not.toBeNull();
    expect(editor.find(".expire-remove")).toBeNull();
    expect(editor.find(".delete-document")).not.toBeNull();
  });

  test("an expiry by duration is confirmed, sent in seconds, then shown", async () => {
    const { fill, click, requests, confirmations, text, find } = setUp("edit");
    fill(".expire-in-count", "2");
    fill(".expire-in-unit", "weeks");

    await click(".expire-in-set");

    expect(requests).toEqual([14 * DAY]);
    expect(confirmations[0]).toContain(formatDate((NOW + 14 * DAY) * 1000));
    expect(text()).toContain("(in 14 days)");
    expect(find(".expire-remove")).not.toBeNull();
  });

  test("an expiry by date is sent as the seconds from now", async () => {
    const { fill, click, requests } = setUp("edit");
    const at = new Date(NOW_MS + 36 * 3600 * 1000);
    const local = new Date(at.getTime() - at.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 16);
    fill(".expire-on-date", local);

    await click(".expire-on-set");

    expect(requests).toEqual([36 * 3600]);
  });

  test("declined, or out of bounds, nothing is sent", async () => {
    const declined = setUp("edit", { confirmed: false });
    declined.fill(".expire-in-count", "1");
    await declined.click(".expire-in-set");
    expect(declined.requests).toEqual([]);

    const { fill, click, requests, confirmations, text } = setUp("edit");
    for (const count of ["0", "-1", "1.5", "", "5300"]) {
      fill(".expire-in-count", count);
      fill(".expire-in-unit", "weeks");
      await click(".expire-in-set");
    }
    fill(".expire-on-date", "2020-01-01T00:00");
    await click(".expire-on-set");
    fill(".expire-on-date", "");
    await click(".expire-on-set");
    expect(requests).toEqual([]);
    expect(confirmations).toEqual([]);
    expect(text()).toContain("Choose a date in the future.");
  });

  test("removing the expiry sends none, without asking", async () => {
    const { click, requests, confirmations, text } = setUp("edit", {
      expiresAt: NOW + DAY,
    });

    await click(".expire-remove");

    expect(requests).toEqual([null]);
    expect(confirmations).toEqual([]);
    expect(text()).toContain("Kept until an editor deletes it.");
  });

  test("offline or dropped, the page says the expiry wasn't confirmed", async () => {
    for (const options of [{ connected: false }, { reply: "drop" as const }]) {
      const { fill, click, text } = setUp("edit", options);
      fill(".expire-in-count", "1");
      await click(".expire-in-set");
      expect(text()).toContain("not confirmed");
      expect(text()).toContain("Kept until an editor deletes it.");
    }
  });

  test("deleting is confirmed by typing a word, the zone saying each keeps a local copy", async () => {
    const { click, deletions, confirmations, find, type, text } = setUp("edit");
    expect(text()).toContain("local copy");
    expect(find(".delete-document")?.disabled).toBe(true);
    type(".delete-confirm", "dlete");
    expect(find(".delete-document")?.disabled).toBe(true);
    type(".delete-confirm", " Delete ");
    expect(find(".delete-document")?.disabled).toBe(false);
    await click(".delete-document");
    expect(deletions()).toBe(1);
    expect(confirmations).toEqual([]);

    const offline = setUp("edit", { connected: false });
    offline.type(".delete-confirm", "delete");
    await offline.click(".delete-document");
    expect(offline.text()).toContain("Not connected");
  });

  test("once deleted, the section says so and offers nothing", () => {
    const { lifecycle, text, find } = setUp("edit", { expiresAt: NOW + DAY });

    lifecycle.deleted();

    expect(text()).toContain("Deleted from the server.");
    expect(find(".expire-in-set")).toBeNull();
    expect(find(".delete-document")).toBeNull();
  });

  test("an expiry learned at a reconnection is shown", () => {
    const { lifecycle, text } = setUp("read");

    lifecycle.setExpiry(NOW + 2 * DAY);

    expect(text()).toContain("(in 2 days)");
  });
});
