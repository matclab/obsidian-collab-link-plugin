// @vitest-environment jsdom
// Who else is here (ADR-0025 §7): their names, said not verified;
// rendered when the presence changes, never otherwise.
import { describe, expect, test } from "vitest";
import type { RemotePresence } from "../../../lib/src/presence/presence.js";
import { createHereNow } from "./here-now.js";

function fakePresence(initial: RemotePresence[]) {
  let others = initial;
  let listener: (() => void) | undefined;
  return {
    presence: {
      others: () => others,
      subscribe(next: () => void) {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    },
    set(next: RemotePresence[]) {
      others = next;
      listener?.();
    },
    subscribed: () => listener !== undefined,
  };
}

const bob: RemotePresence = {
  key: "b",
  seq: 1,
  name: "bob",
  color: "#00798c",
  anchor: 1,
  head: 1,
};

describe("here now", () => {
  test("nobody, then one dot per person, their names said not verified", () => {
    const container = document.createElement("div");
    const fake = fakePresence([]);
    createHereNow(container, fake.presence);
    const group = () => container.querySelector(".presence");
    const dots = () => Array.from(container.querySelectorAll(".avatar"));
    expect(dots()).toHaveLength(0);
    expect(group()?.getAttribute("aria-label")).toContain("Nobody else here");

    fake.set([bob, { ...bob, key: "c", name: "carol", color: "#d1495b" }]);

    expect(dots().map((dot) => dot.textContent?.trim())).toEqual(["B", "C"]);
    expect(dots().map((dot) => dot.getAttribute("title"))).toEqual([
      "bob",
      "carol",
    ]);
    expect(group()?.getAttribute("aria-label")).toContain(
      "Here now: bob, carol",
    );
    expect(group()?.getAttribute("title")).toContain("not verified");
  });

  test("destroyed, it stops listening", () => {
    const container = document.createElement("div");
    const fake = fakePresence([bob]);
    const hereNow = createHereNow(container, fake.presence);
    hereNow.destroy();
    expect(fake.subscribed()).toBe(false);
  });
});

// ID-39: a presence attested at its reception shows the attested name,
// and says who attests it.
test("an attested presence: its attested name, and who attests it", () => {
  const container = document.createElement("div");
  const fake = fakePresence([bob]);
  const signatures = {
    current: () => ({
      of: () => ({
        signed: true as const,
        fingerprint: new Uint8Array(32),
        short: "0000 0000 0000 0000",
        twoKeys: false,
        attested: {
          id: "ab".repeat(32),
          issuer: "https://idp.example",
          sub: "s",
          name: "Robert",
          key: new Uint8Array(32),
          issuedAt: 1,
          expiresAt: 2,
        },
      }),
      version: () => "1",
    }),
    subscribe: () => () => {},
  };
  createHereNow(
    container,
    fake.presence,
    signatures as unknown as Parameters<typeof createHereNow>[2],
  );
  const dot = container.querySelector(".avatar");
  expect(dot?.textContent?.trim()).toBe("R");
  expect(dot?.getAttribute("title")).toBe(
    "Robert, verified by https://idp.example",
  );
});
