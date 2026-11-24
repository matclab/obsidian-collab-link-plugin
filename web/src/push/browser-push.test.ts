// The Push API, read for `DevicePush`: none without a worker or a
// PushManager; a subscription under another key replaced.
import { describe, expect, test } from "vitest";
import { browserDevicePush } from "./browser-push.js";

const KEY = Uint8Array.of(4, ...new Uint8Array(64).fill(9));
const OTHER = Uint8Array.of(4, ...new Uint8Array(64).fill(8));

function subscription(endpoint: string, key: Uint8Array | null) {
  let gone = false;
  return {
    endpoint,
    options: { applicationServerKey: key ? key.buffer.slice(0) : null },
    getKey: (name: string) =>
      name === "p256dh"
        ? new Uint8Array(65).fill(4).buffer
        : new Uint8Array(16).buffer,
    unsubscribe: async () => {
      gone = true;
      return true;
    },
    get gone() {
      return gone;
    },
  };
}

function manager(initial?: ReturnType<typeof subscription>) {
  let held = initial;
  const made: Uint8Array[] = [];
  return {
    made,
    pushManager: {
      getSubscription: async () => (held && !held.gone ? held : null),
      subscribe: async (options: { applicationServerKey: BufferSource }) => {
        const key = new Uint8Array(options.applicationServerKey as ArrayBuffer);
        made.push(key);
        held = subscription(`https://push.example/${made.length}`, key);
        return held;
      },
    },
  };
}

describe("this browser's push", () => {
  test("none without a worker or a PushManager", () => {
    expect(browserDevicePush(undefined, true)).toBeUndefined();
    expect(
      browserDevicePush({ ready: Promise.resolve({}) }, false),
    ).toBeUndefined();
  });

  test("reads the subscription held, with its key", async () => {
    const m = manager(subscription("https://push.example/held", KEY) as never);
    const push = browserDevicePush(
      { ready: Promise.resolve(m as never) },
      true,
    );
    const current = await push?.current();
    expect(current?.endpoint).toBe("https://push.example/held");
    expect(current?.serverKey).toEqual(KEY);
    expect(current?.p256dh.length).toBe(65);
    expect(current?.auth.length).toBe(16);
  });

  test("subscribes once; one made with another key is replaced", async () => {
    const old = subscription("https://push.example/old", OTHER);
    const m = manager(old as never);
    const push = browserDevicePush(
      { ready: Promise.resolve(m as never) },
      true,
    );
    const made = await push?.subscribe(KEY);
    expect(old.gone).toBe(true);
    expect(made?.serverKey).toEqual(KEY);
    expect(await push?.subscribe(KEY)).toEqual(made);
    expect(m.made.length).toBe(1);
  });
});
