import { describe, expect, test } from "vitest";
import { verifiers } from "../crypto/index.js";
import {
  forgetPendingSecret,
  pendingSecret,
  renewLinks,
} from "./renew-links.js";

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => {
      items.delete(key);
    },
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}

describe("renewLinks (ADR-0019 §5, R-B4)", () => {
  test("keeps the new edit secret before sending the rotation", async () => {
    const storage = memoryStorage();
    const sent: { secret: Uint8Array; kept: Uint8Array | undefined }[] = [];
    const connection = {
      async rotate(next: {
        secret: Uint8Array;
        verifiers: Record<string, Uint8Array>;
      }) {
        sent.push({
          secret: next.secret,
          kept: pendingSecret(storage, "doc"),
        });
        expect(next.verifiers).toEqual(await verifiers(next.secret));
      },
    };

    await renewLinks("doc", connection, storage);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.kept).toEqual(sent[0]?.secret);
  });

  test("the kept secret is per document, and forgotten on demand", () => {
    const storage = memoryStorage();
    storage.setItem("oc:rotation:doc", "AAAA");

    expect(pendingSecret(storage, "other")).toBeUndefined();
    expect(pendingSecret(storage, "doc")).toEqual(new Uint8Array([0, 0, 0]));
    forgetPendingSecret(storage, "doc");
    expect(pendingSecret(storage, "doc")).toBeUndefined();
  });

  test("an unreadable kept secret is ignored", () => {
    const storage = memoryStorage();
    storage.setItem("oc:rotation:doc", "not base64!");

    expect(pendingSecret(storage, "doc")).toBeUndefined();
  });

  test("refuses to rotate if the secret cannot be kept", async () => {
    const storage = memoryStorage();
    storage.setItem = () => {
      throw new Error("quota");
    };
    let rotated = false;

    await expect(
      renewLinks(
        "doc",
        {
          async rotate() {
            rotated = true;
          },
        },
        storage,
      ),
    ).rejects.toThrow();
    expect(rotated).toBe(false);
  });

  // TR2 (docs/phase-18-trousseau-identite.md): the new edit secret goes
  // where the client keeps its links (a keyring) before the rotation is
  // sent; if it can't, nothing is sent, and nothing is left pending.
  test("waits for beforeSend, and sends nothing if it fails", async () => {
    const storage = memoryStorage();
    const order: string[] = [];
    const connection = {
      async rotate() {
        order.push("rotate");
      },
    };
    await renewLinks("doc", connection, storage, async (secret) => {
      expect(pendingSecret(storage, "doc")).toEqual(secret);
      await Promise.resolve();
      order.push("kept");
    });
    expect(order).toEqual(["kept", "rotate"]);

    order.length = 0;
    forgetPendingSecret(storage, "doc");
    await expect(
      renewLinks("doc", connection, storage, async () => {
        throw new Error("keyring not saved");
      }),
    ).rejects.toThrow("keyring not saved");
    expect(order).toEqual([]);
    expect(pendingSecret(storage, "doc")).toBeUndefined();
  });
});
