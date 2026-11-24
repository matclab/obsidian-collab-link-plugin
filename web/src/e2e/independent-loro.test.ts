import {
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linkIndependentLoro } from "./independent-loro.js";

describe("linkIndependentLoro", () => {
  let base: string;
  const link = () =>
    path.join(base, "independent-client/node_modules/loro-crdt");
  const target = () => path.join(base, "web/node_modules/loro-crdt-1163");

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), "independent-loro-"));
    mkdirSync(target(), { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("links the independent client to the pinned Loro", () => {
    linkIndependentLoro(base);
    expect(readlinkSync(link())).toBe(target());
  });

  it("replaces a link to a folder that no longer exists", () => {
    // The project moved or its old path is gone: the link dangles.
    mkdirSync(path.dirname(link()), { recursive: true });
    symlinkSync(path.join(base, "gone/loro-crdt-1163"), link());
    linkIndependentLoro(base);
    expect(readlinkSync(link())).toBe(target());
  });

  it("replaces a link to another Loro", () => {
    const other = path.join(base, "web/node_modules/loro-crdt");
    mkdirSync(other, { recursive: true });
    mkdirSync(path.dirname(link()), { recursive: true });
    symlinkSync(other, link());
    linkIndependentLoro(base);
    expect(readlinkSync(link())).toBe(target());
  });
});
