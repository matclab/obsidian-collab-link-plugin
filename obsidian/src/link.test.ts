// A link pasted into the plugin (docs/phase-14-plugin-obsidian.md,
// decision 9): the page's own links, from any server; the secret only
// over TLS, except to this computer (as the library, `assertSecureUrl`).
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import {
  documentLinks,
  exportKeyToBase64Url,
  generateKey,
} from "../../web/lib/src/index.js";
import { parseDocumentLink } from "./link.js";

const ROLES = ["read", "suggest", "edit"] as const;

async function linksFor(base: string, documentId: string) {
  const key = await exportKeyToBase64Url(await generateKey());
  const secret = crypto.getRandomValues(new Uint8Array(32));
  return { key, links: await documentLinks(base, documentId, key, secret) };
}

describe("a pasted link", () => {
  test("any of the page's links, from any server over TLS, opens its document with its role and key", async () => {
    await hegel.testAsync(
      async (tc) => {
        const host = tc.draw(gs.domains());
        const port = tc.draw(gs.sampledFrom(["", ":8443"]));
        const documentId = tc.draw(
          gs.fromRegex("[A-Za-z0-9_-]{1,40}", { fullmatch: true }),
        );
        const role = tc.draw(gs.sampledFrom(ROLES));
        const padding = tc.draw(gs.sampledFrom(["", " ", "\n", "  \t"]));
        const { key, links } = await linksFor(
          `https://${host}${port}/`,
          documentId,
        );

        const parsed = parseDocumentLink(`${padding}${links[role]}${padding}`);

        if (!parsed.ok) throw new Error(`refused: ${parsed.problem}`);
        expect(parsed.link.apiBase).toBe(
          new URL(`https://${host}${port}`).origin,
        );
        expect(parsed.link.documentId).toBe(documentId);
        expect(parsed.link.fragment.role).toBe(role);
        expect(parsed.link.fragment.key).toBe(key);
      },
      { testCases: 50 },
    );
  });

  test("over plain http, only to this computer", async () => {
    for (const host of ["localhost:8080", "127.0.0.1:18047", "[::1]:3000"]) {
      const { links } = await linksFor(`http://${host}/`, "doc");
      expect(parseDocumentLink(links.edit).ok).toBe(true);
    }
    await hegel.testAsync(
      async (tc) => {
        const host = tc.draw(gs.domains());
        const { links } = await linksFor(`http://${host}/`, "doc");
        expect(parseDocumentLink(links.read)).toEqual({
          ok: false,
          problem: "insecure",
        });
      },
      { testCases: 30 },
    );
  });

  test("names no document, or carries no key: refused, saying which", async () => {
    const { links } = await linksFor("https://collab.test/", "doc");
    expect(parseDocumentLink("https://collab.test/#k=x")).toEqual({
      ok: false,
      problem: "not-a-link",
    });
    expect(parseDocumentLink(links.edit.replace(/#.*/, ""))).toEqual({
      ok: false,
      problem: "invalid",
    });
    expect(parseDocumentLink("collab.test/?doc=x").ok).toBe(false);
    expect(parseDocumentLink("ftp://collab.test/?doc=x#k=y").ok).toBe(false);
  });

  test("whatever is pasted, it answers, never throws", () => {
    hegel.test(
      (tc) => {
        const text = tc.draw(
          gs.oneOf(
            gs.text(),
            gs.urls(),
            gs.fromRegex("https?://[a-z.]{1,12}/\\?doc=[^#]{0,8}#.{0,40}", {
              fullmatch: true,
            }),
          ),
        );
        const parsed = parseDocumentLink(text);
        expect(typeof parsed.ok).toBe("boolean");
      },
      { testCases: 300 },
    );
  });
});
