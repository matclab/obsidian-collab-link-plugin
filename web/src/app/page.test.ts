// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// The page as the binary serves it (phase 9, N1): `npm run build` copies it
// into `dist/`, next to its bundle. Its policy is a header of the server
// (`server/page`, `POLICY`), and it talks to its own origin.
const page = new DOMParser().parseFromString(
  readFileSync(join(import.meta.dirname, "../../index.html"), "utf8"),
  "text/html",
);

describe("the page", () => {
  test("is titled Collab Link, as the plugin; the sign-in's return too", () => {
    expect(page.title).toBe("Collab Link");
    const authReturn = new DOMParser().parseFromString(
      readFileSync(join(import.meta.dirname, "../../auth-return.html"), "utf8"),
      "text/html",
    );
    expect(authReturn.title).toBe("Collab Link");
  });

  test("carries no policy of its own: the server's header is the only one", () => {
    expect(
      page.querySelector('meta[http-equiv="Content-Security-Policy"]'),
    ).toBeNull();
  });

  test("names no server: it talks to its own origin", () => {
    expect(page.querySelector('meta[name="server-base"]')).toBeNull();
  });

  test("fits the width of a phone's screen instead of a desktop's, shrunk", () => {
    expect(
      page.querySelector('meta[name="viewport"]')?.getAttribute("content"),
    ).toBe("width=device-width, initial-scale=1");
  });

  test("holds no style of its own: its stylesheet comes from next to it", () => {
    expect(page.querySelector("style")).toBeNull();
    const sheets = Array.from(
      page.querySelectorAll('link[rel="stylesheet"]'),
      (link) => link.getAttribute("href"),
    );
    expect(sheets).toEqual(["./main.css"]);
  });

  test("has an icon of its own, inline: no request, nothing to cache", () => {
    const icon = page.querySelector('link[rel="icon"]')?.getAttribute("href");
    expect(icon).toMatch(/^data:image\/svg\+xml,/);
  });

  test("loads its bundle from next to it", () => {
    const scripts = Array.from(page.querySelectorAll("script"), (script) =>
      script.getAttribute("src"),
    );
    expect(scripts).toEqual(["./main.js"]);
  });
});
