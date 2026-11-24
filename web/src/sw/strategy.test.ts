// What the service worker does with each request (phase 9, SW3), as pure
// functions: the page from the network first, the files of its version
// from its own cache, and nothing else intercepted.
import { describe, expect, test } from "vitest";
import {
  type Manifest,
  cacheName,
  decide,
  pageMatches,
  staleCaches,
} from "./strategy.js";

const scope = "https://notes.example/";
const manifest: Manifest = {
  version: "v1",
  entry: "assets/main-AAAA1111.js",
  precache: [
    "index.html",
    "assets/main-AAAA1111.js",
    "assets/loro_wasm_bg-BBBB2222.wasm",
  ],
  files: [
    "index.html",
    "assets/main-AAAA1111.js",
    "assets/loro_wasm_bg-BBBB2222.wasm",
    "assets/chunks/lazy-CCCC3333.js",
  ],
};
const request = (url: string, mode = "cors", method = "GET") => ({
  url,
  mode,
  method,
});

describe("decide", () => {
  test("analysis 18k: the deployment's configuration and revocation list, network first and kept", () => {
    for (const path of ["config.json", "revocations"]) {
      expect(decide(request(`${scope}${path}`), scope, manifest)).toEqual({
        kind: "deployment",
        path,
      });
      // Anything else of them goes past: a query, another method.
      expect(decide(request(`${scope}${path}?x`), scope, manifest)).toEqual({
        kind: "pass",
      });
      expect(
        decide(request(`${scope}${path}`, "cors", "PUT"), scope, manifest),
      ).toEqual({ kind: "pass" });
    }
  });

  test("a navigation to the page, with or without its document and key, is the page", () => {
    for (const url of [
      "https://notes.example/",
      "https://notes.example/?doc=abc",
      "https://notes.example/index.html",
      "https://notes.example/?doc=abc#k=x&r=read.y",
    ]) {
      expect(decide(request(url, "navigate"), scope, manifest), url).toEqual({
        kind: "page",
      });
    }
  });

  test("a file of this version is served from its cache", () => {
    for (const path of manifest.files.filter((file) => file !== "index.html")) {
      expect(decide(request(`${scope}${path}`), scope, manifest)).toEqual({
        kind: "file",
        path,
      });
    }
  });

  test("everything else goes to the network untouched", () => {
    for (const [url, mode, method] of [
      ["https://notes.example/documents", "cors", "POST"],
      ["https://notes.example/ws", "websocket", "GET"],
      ["https://notes.example/assets/main-ZZZZ9999.js", "cors", "GET"], // another version
      ["https://notes.example/assets/main-AAAA1111.js?x=1", "cors", "GET"],
      ["https://notes.example/assets/main-AAAA1111.js", "cors", "HEAD"],
      ["https://notes.example/favicon.ico", "no-cors", "GET"],
      ["https://notes.example/other", "navigate", "GET"],
      ["https://elsewhere.example/assets/main-AAAA1111.js", "cors", "GET"],
      ["https://notes.example/index.html", "cors", "GET"], // not a navigation
    ] as const) {
      expect(
        decide(request(url, mode, method), scope, manifest),
        `${method} ${url}`,
      ).toEqual({
        kind: "pass",
      });
    }
  });

  test("under a path of a reverse proxy, paths are relative to the scope", () => {
    const proxied = "https://host.example/notes/";
    expect(
      decide(
        request("https://host.example/notes/?doc=a", "navigate"),
        proxied,
        manifest,
      ),
    ).toEqual({
      kind: "page",
    });
    expect(
      decide(request(`${proxied}assets/main-AAAA1111.js`), proxied, manifest),
    ).toEqual({
      kind: "file",
      path: "assets/main-AAAA1111.js",
    });
    expect(
      decide(request("https://host.example/", "navigate"), proxied, manifest),
    ).toEqual({
      kind: "pass",
    });
  });
});

describe("caches", () => {
  test("one cache per version; the others of this page are stale, other caches untouched", () => {
    expect(cacheName("v1")).toBe("oc-v1");
    expect(
      staleCaches(["oc-v0", "oc-v1", "someone-else", "oc-v2"], "v1"),
    ).toEqual(["oc-v0", "oc-v2"]);
  });

  test("an installed page must be the one of this version (a deployment may be under way)", () => {
    expect(
      pageMatches(
        '<script type="module" src="./assets/main-AAAA1111.js"></script>',
        manifest,
      ),
    ).toBe(true);
    expect(
      pageMatches(
        '<script type="module" src="./assets/main-ZZZZ9999.js"></script>',
        manifest,
      ),
    ).toBe(false);
  });
});
