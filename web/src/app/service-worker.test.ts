// The page registers its service worker (phase 9, SW5) where the browser
// has them, and an error there never stops the page.
import { describe, expect, test } from "vitest";
import { registerServiceWorker } from "./service-worker.js";

describe("registerServiceWorker", () => {
  test("registers the worker next to the page", async () => {
    const registered: string[] = [];
    await registerServiceWorker({
      register: async (url: string) => {
        registered.push(url);
      },
    });
    expect(registered).toEqual(["./sw.js"]);
  });

  test("does nothing without service workers (jsdom, Firefox's private windows)", async () => {
    await expect(registerServiceWorker(undefined)).resolves.toBeUndefined();
  });

  test("a refused registration is logged, not thrown", async () => {
    const logged: unknown[] = [];
    await registerServiceWorker(
      {
        register: async () => {
          throw new Error("refused");
        },
      },
      (...args) => logged.push(args),
    );
    expect(logged).toHaveLength(1);
  });
});
