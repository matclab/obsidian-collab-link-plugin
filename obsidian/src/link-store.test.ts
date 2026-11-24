// The links, kept in `app.secretStorage` (docs/phase-14-plugin-obsidian.md,
// decision 5): in Obsidian's own storage, per vault, outside the vault's
// files, encrypted by the system's keyring when there is one.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import {
  documentLinks,
  exportKeyToBase64Url,
  generateKey,
} from "../../web/lib/src/index.js";
import { LinkStore, secretId, withFormerIds } from "./link-store.js";
import { fakeSecrets } from "./test-support/secrets.js";

async function editLink(documentId: string) {
  const key = await exportKeyToBase64Url(await generateKey());
  const secret = crypto.getRandomValues(new Uint8Array(32));
  return (await documentLinks("https://collab.test/", documentId, key, secret))
    .edit;
}

describe("the links' store", () => {
  test("a link kept is there for its document, and only its", async () => {
    const store = new LinkStore(fakeSecrets());
    store.set("doc", await editLink("doc"));
    // The server's ids: 32 hexadecimal digits.
    const id = "1d3622d766f1bef1d0be1c7118d5d1f2";
    store.set(id, await editLink(id));
    expect(store.get(id)?.documentId).toBe(id);
    expect(store.get("doc")?.documentId).toBe("doc");
    expect(store.get("doc")?.fragment.role).toBe("edit");
    expect(store.get("other")).toBeUndefined();
  });

  test("any document's id, or storage key, makes a valid secret id, and two never share one", () => {
    hegel.test(
      (tc) => {
        const name = gs.oneOf(
          gs.fromRegex("[A-Za-z0-9_-]{1,64}", { fullmatch: true }),
          gs.fromRegex("[a-f0-9]{32}", { fullmatch: true }),
          gs.text({ maxSize: 80 }),
        );
        const [a, b] = [tc.draw(name), tc.draw(name)];
        for (const kind of ["link", "storage"]) {
          expect(secretId(kind, a ?? "")).toMatch(/^[a-z0-9-]{1,64}$/);
        }
        if (a !== b) {
          expect(secretId("link", a ?? "")).not.toBe(secretId("link", b ?? ""));
        }
      },
      { testCases: 200 },
    );
  });

  test("forgotten, a link is gone (the store can't remove: it is emptied)", async () => {
    const secrets = fakeSecrets();
    const store = new LinkStore(secrets);
    store.set("doc", await editLink("doc"));
    store.forget("doc");
    expect(store.get("doc")).toBeUndefined();
    expect([...secrets.values.values()]).toEqual([""]);
  });

  test("what isn't a document's link is not kept", () => {
    const store = new LinkStore(fakeSecrets());
    expect(() => store.set("doc", "https://collab.test/?doc=doc")).toThrow();
    expect(store.get("doc")).toBeUndefined();
  });
});

describe("secrets kept under the plugin's former name (Collab Link)", () => {
  test("found under the former id, then kept under the new one", async () => {
    const secrets = fakeSecrets();
    const url = await editLink("doc");
    secrets.setSecret("collab-link-link-d-doc", url);
    const store = new LinkStore(withFormerIds(secrets));
    expect(store.get("doc")?.documentId).toBe("doc");
    expect(secrets.getSecret(secretId("link", "doc"))).toBe(url);
  });

  test("a secret emptied under the new id stays emptied", async () => {
    const secrets = fakeSecrets();
    secrets.setSecret("collab-link-link-d-doc", await editLink("doc"));
    const store = new LinkStore(withFormerIds(secrets));
    store.forget("doc");
    expect(store.get("doc")).toBeUndefined();
  });

  test("the new ids are the plugin's", () => {
    expect(secretId("link", "doc")).toBe("collab-link-link-d-doc");
  });
});
