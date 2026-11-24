import type { EditorView } from "@codemirror/view";
// @vitest-environment jsdom
//
// The page's early events (docs/phase-12-refactorisation.md, analysis
// 12c.1): a rotation, an expiry, a deletion, a Loro panic, each at any
// step of the opening — before `openDocument` resolves, while the share
// panel's links are computed, once the page is up — and the links of
// several rotations computed in any order. The test decides every moment:
// `openDocument` resolves when it says, each `documentLinks` call ends when
// it says. Whatever the order, the page ends showing the last links, the
// last expiry, a read-only editor after a deletion, and halts once, with
// the first panic.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import {
  CloseCode,
  createDocument,
  documentLinks,
} from "../../lib/src/index.js";
import { eventually } from "../../lib/src/transport/test-support/eventually.js";
import { FakeServer } from "../../lib/src/transport/test-support/fake-server.js";
import { t } from "../i18n/index.js";
import { describeExpiry } from "../ui/menu/document-lifecycle.js";
import { type OpenedDocument, openDocument } from "./open-document.js";
import { type PageEnvironment, startPage } from "./page.js";

const ORIGIN = "https://collab.test";
const NOW = 1_900_000_000;
const EXPIRIES = [null, NOW + 3 * 86_400, NOW + 30 * 86_400];

/** A `Storage` in memory, with a name already chosen (no dialog). */
function memoryStorage(): Storage {
  const items = new Map<string, string>([
    ["obsidian-collab:pseudonym", "alice"],
  ]);
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

type Move = "renew" | "expire" | "delete" | "trap" | "links" | "open";

describe("the page's early events", () => {
  test("whatever moment each comes at, the page ends on the last links and expiry, read-only once deleted, halted once by the first panic", async () => {
    const created = await createDocument(ORIGIN, async () =>
      Response.json({ document_id: "doc" }),
    );
    const firstLinks = await documentLinks(
      `${ORIGIN}/`,
      "doc",
      created.keyMaterial,
      created.editSecret,
    );

    await hegel.testAsync(
      async (tc) => {
        document.body.innerHTML = "";
        const server = new FakeServer();
        const address = new URL(firstLinks.edit);
        const window = new EventTarget();
        let options: Parameters<typeof openDocument>[0] | undefined;
        let opened: OpenedDocument | undefined;
        let view: EditorView | undefined;
        let releaseOpen: (() => void) | undefined;
        const links: { release: () => void }[] = [];
        // Computations the test doesn't time (WebCrypto): waited for.
        let computing = 0;
        const halts: unknown[] = [];
        let lastExpiry: number | null = null;
        let pageDone = false;

        const env: PageEnvironment = {
          root: document.body,
          location: () => address,
          replaceAddress: (url) => {
            address.href = url;
          },
          reload: () => {},
          storage: memoryStorage(),
          indexedDB: undefined,
          lock: undefined,
          languages: ["en"],
          online: () => true,
          window,
          confirm: () => true,
          copy: async () => {},
          registerServiceWorker: async () => {},
          createDocument: () => Promise.reject(new Error("not here")),
          createKeyring: () => Promise.reject(new Error("not here")),
          now: () => Date.now(),
          // Each call ends when the test releases it — its gate known at
          // once, whatever the computation's own pace.
          documentLinks: async (...args) => {
            const gate = new Promise<void>((release) =>
              links.push({ release }),
            );
            computing++;
            const computed = await documentLinks(...args).finally(() => {
              computing--;
            });
            await gate;
            return computed;
          },
          openDocument: async (given) => {
            options = given;
            const real = await openDocument({
              ...given,
              socketFactory: () => server.connect(),
              onExpiry: (at) => {
                lastExpiry = at;
                given.onExpiry?.(at);
              },
              onWired: (client) => {
                view = client.editor.view;
                given.onWired?.(client);
              },
            });
            const halt = real.halt;
            real.halt = (error) => {
              halts.push(error);
              halt(error);
            };
            opened = real;
            await new Promise<void>((resolve) => {
              releaseOpen = resolve;
            });
            return real;
          },
        };
        server.now = NOW;
        const page = startPage(env).then(() => {
          pageDone = true;
        });
        await eventually(() => releaseOpen !== undefined);
        /** Until nothing runs that the test doesn't time: what follows a
         * release runs up to the next gate. */
        const settle = async () => {
          do {
            await eventually(() => computing === 0);
            await flush();
          } while (computing > 0);
        };

        let secret = created.editSecret;
        let renewals = 0;
        let deleted = false;
        let firstTrap: unknown;
        const left = { renew: 2, expire: 2, delete: 1, trap: 2 };
        for (let step = 0; ; step++) {
          if (step > 60) throw new Error("the page never settles");
          const moves: Move[] = [];
          if (!pageDone || links.length > 0) {
            for (const [move, count] of Object.entries(left)) {
              if (count > 0) moves.push(move as Move);
            }
          }
          if (links.length > 0) moves.push("links");
          if (releaseOpen) moves.push("open");
          if (moves.length === 0) break;
          const move = tc.draw(gs.sampledFrom(moves));
          if (move !== "links" && move !== "open") left[move]--;
          if (move === "renew") {
            secret = crypto.getRandomValues(new Uint8Array(32));
            renewals++;
            options?.onRenewed?.(secret);
          } else if (move === "expire") {
            const at = tc.draw(gs.sampledFrom(EXPIRIES));
            lastExpiry = at;
            options?.onExpiry?.(at);
          } else if (move === "delete") {
            deleted = true;
            options?.onRefused?.(CloseCode.Deleted);
          } else if (move === "trap") {
            const error = new WebAssembly.RuntimeError("unreachable");
            firstTrap ??= error;
            window.dispatchEvent(Object.assign(new Event("error"), { error }));
          } else if (move === "links") {
            const index = tc.draw(
              gs.integers({ minValue: 0, maxValue: links.length - 1 }),
            );
            links.splice(index, 1)[0]?.release();
          } else {
            const release = releaseOpen;
            releaseOpen = undefined;
            release?.();
          }
          await settle();
        }
        await page;

        const expected = await documentLinks(
          `${ORIGIN}/`,
          "doc",
          created.keyMaterial,
          secret,
        );
        const shown =
          document.querySelector<HTMLInputElement>("input.share-edit");
        expect(shown?.value).toBe(expected.edit);
        expect(document.querySelector(".share-renewed") !== null).toBe(
          renewals > 0,
        );
        if (renewals > 0) expect(address.href).toBe(expected.edit);
        expect(document.querySelector(".lifecycle-expiry")?.textContent).toBe(
          deleted
            ? t().deletedFromServer
            : describeExpiry(lastExpiry, Date.now()),
        );
        if (deleted) expect(view?.state.readOnly).toBe(true);
        expect(halts.length > 0).toBe(firstTrap !== undefined);
        if (firstTrap !== undefined) expect(halts[0]).toBe(firstTrap);

        opened?.presence.destroy();
        opened?.connection.close();
        // A focus change leaves CodeMirror a 10 ms timer: on a live view, it
        // would fire after jsdom is gone (no `requestAnimationFrame`).
        view?.destroy();
      },
      { testCases: 100 },
    );
  }, 600_000);
});
