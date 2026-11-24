// The invitation to be notified (phase 34j, NI1 – NI3): what it offers,
// from what I wrote here, the permission, this device in this document,
// and the documents where it was answered.
import { describe, expect, test } from "vitest";
import {
  type InviteFacts,
  answeredInvites,
  inviteOffer,
  rememberInvite,
} from "./alerts-invite.js";

const facts = (over: Partial<InviteFacts> = {}): InviteFacts => ({
  documentId: "doc-1",
  written: true,
  permission: "default",
  device: "off",
  attempt: "idle",
  answered: [],
  ...over,
});

describe("what the invitation offers", () => {
  test("both tiers, once I published here", () => {
    expect(inviteOffer(facts())).toEqual({ browser: true, device: true });
  });

  test("nothing before I publish (NI1)", () => {
    expect(inviteOffer(facts({ written: false }))).toBeUndefined();
  });

  test("nothing while this device's state is unknown", () => {
    expect(inviteOffer(facts({ device: "pending" }))).toBeUndefined();
    expect(inviteOffer(facts({ device: "checking" }))).toBeUndefined();
  });

  test("the browser alone without Web Push; this device alone once allowed (NI2)", () => {
    expect(inviteOffer(facts({ device: "unsupported" }))).toEqual({
      browser: true,
      device: false,
    });
    expect(inviteOffer(facts({ permission: "granted" }))).toEqual({
      browser: false,
      device: true,
    });
  });

  test("nothing left to offer: nothing (NI2)", () => {
    expect(
      inviteOffer(facts({ permission: "granted", device: "on" })),
    ).toBeUndefined();
    expect(
      inviteOffer(facts({ permission: "denied", device: "unsupported" })),
    ).toBeUndefined();
    // Refused, the browser refuses this device too.
    expect(inviteOffer(facts({ permission: "denied" }))).toBeUndefined();
    expect(
      inviteOffer(facts({ permission: "unsupported", device: "unsupported" })),
    ).toBeUndefined();
  });

  test("this device, while it changes, isn't offered", () => {
    expect(inviteOffer(facts({ attempt: "busy" }))).toBeUndefined();
  });

  test("this device tried and failed: not offered again, the browser still", () => {
    for (const attempt of ["refused", "no-key"] as const) {
      expect(inviteOffer(facts({ attempt })), attempt).toEqual({
        browser: true,
        device: false,
      });
    }
  });

  test("answered in this document: not again (NI3)", () => {
    expect(inviteOffer(facts({ answered: ["doc-1"] }))).toBeUndefined();
  });

  test("answered elsewhere: again here, while this device is offered (NI3)", () => {
    expect(inviteOffer(facts({ answered: ["doc-2"] }))).toEqual({
      browser: true,
      device: true,
    });
  });

  test("the browser alone, answered anywhere: settled for the device (NI3)", () => {
    expect(
      inviteOffer(facts({ device: "unsupported", answered: ["doc-2"] })),
    ).toBeUndefined();
  });
});

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (i) => [...items.keys()][i] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  };
}

describe("the documents where it was answered", () => {
  test("kept, newest first, once each", () => {
    const storage = memoryStorage();
    rememberInvite(storage, "a");
    rememberInvite(storage, "b");
    rememberInvite(storage, "a");
    expect(answeredInvites(storage)).toEqual(["a", "b"]);
  });

  test("bounded to the last 100", () => {
    const storage = memoryStorage();
    for (let i = 0; i < 105; i++) rememberInvite(storage, `d${i}`);
    const kept = answeredInvites(storage);
    expect(kept).toHaveLength(100);
    expect(kept[0]).toBe("d104");
    expect(kept).not.toContain("d4");
  });

  test("nothing kept, or unreadable: none", () => {
    expect(answeredInvites(undefined)).toEqual([]);
    const storage = memoryStorage();
    storage.setItem("obsidian-collab:notify-invites", "{not json");
    expect(answeredInvites(storage)).toEqual([]);
    storage.setItem("obsidian-collab:notify-invites", '[1,"x",null]');
    expect(answeredInvites(storage)).toEqual(["x"]);
  });

  test("a storage that refuses: nothing thrown", () => {
    const storage = memoryStorage();
    storage.setItem = () => {
      throw new Error("quota");
    };
    expect(() => rememberInvite(storage, "a")).not.toThrow();
    expect(() => rememberInvite(undefined, "a")).not.toThrow();
  });
});
