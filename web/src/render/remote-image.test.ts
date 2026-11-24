import { describe, expect, test } from "vitest";
import { loadableImageSource } from "./remote-image.js";

describe("loadableImageSource (ADR-0055 §2, §11)", () => {
  test("an image of a public site, by https, with a path", () => {
    expect(loadableImageSource("https://example.org/a.png")).toBe(
      "https://example.org/a.png",
    );
    expect(loadableImageSource("https://img.example.org:8443/a?b=c")).toBe(
      "https://img.example.org:8443/a?b=c",
    );
    expect(loadableImageSource("HTTPS://Example.ORG/")).toBe(
      "https://example.org/",
    );
  });

  test("never another scheme", () => {
    for (const src of [
      "http://example.org/a.png",
      "//example.org/a.png",
      "data:image/png;base64,iVBO",
      "ftp://example.org/a.png",
      "img/a.png",
      "/a.png",
      "javascript:alert(1)",
    ]) {
      expect(loadableImageSource(src), src).toBeNull();
    }
  });

  test("never an address without a '/' after its host", () => {
    for (const src of [
      "https://example.org",
      "https://example.o",
      "https://example.org?a=1",
      "https://example.org#a",
      "https://example.org:443",
    ]) {
      expect(loadableImageSource(src), src).toBeNull();
    }
  });

  test("never a local host", () => {
    for (const src of [
      "https://localhost/a.png",
      "https://LOCALHOST./a.png",
      "https://app.localhost/a.png",
      "https://printer.local/a.png",
      "https://wiki.internal/a.png",
      "https://nas.home.arpa/a.png",
      "https://intranet/a.png",
      "https://127.0.0.1/a.png",
      "https://192.168.1.1:8443/a.png",
      "https://0x7f.1/a.png",
      "https://2130706433/a.png",
      "https://[::1]/a.png",
      "https://[fe80::1]/a.png",
    ]) {
      expect(loadableImageSource(src), src).toBeNull();
    }
  });

  test("never an address that carries credentials", () => {
    expect(loadableImageSource("https://u:p@example.org/a.png")).toBeNull();
    expect(loadableImageSource("https://u@example.org/a.png")).toBeNull();
  });

  test("never an address the browser would not read", () => {
    expect(loadableImageSource("https://exa mple.org/a.png")).toBeNull();
    expect(loadableImageSource("https:///a.png")).toBeNull();
    expect(loadableImageSource("")).toBeNull();
  });
});
