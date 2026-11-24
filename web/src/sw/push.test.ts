// What the worker shows of a push message, and where a click goes (D-43):
// plain text, one per document; a message of another form, a generic
// one; a click never goes elsewhere than this origin's `?doc=`.
import { describe, expect, test } from "vitest";
import { en } from "../i18n/en.js";
import { clickTarget, shownOf } from "./push.js";

const DOC = "0123456789abcdef0123456789abcdef";
const message = (fields: Record<string, unknown>) =>
  JSON.stringify({
    v: 1,
    kind: "reply",
    doc: DOC,
    annotation: "a",
    title: "Compte rendu",
    name: "Alice",
    excerpt: "D'accord.",
    ...fields,
  });

describe("the worker's notifications", () => {
  test("a reply, a rejection: their texts, one tag per document", () => {
    expect(shownOf(message({}), en)).toEqual({
      title: "Compte rendu",
      body: "Alice replied: D'accord.",
      tag: `oc:${DOC}`,
      doc: DOC,
    });
    expect(shownOf(message({ kind: "rejected", excerpt: "" }), en).body).toBe(
      "Alice rejected your suggestion",
    );
    expect(shownOf(message({ title: "", name: "" }), en)).toMatchObject({
      title: "Untitled document",
      body: "Someone replied: D'accord.",
    });
  });

  test("markup stays text", () => {
    const shown = shownOf(
      message({ excerpt: "<img src=x onerror=alert(1)>" }),
      en,
    );
    expect(shown.body).toBe("Alice replied: <img src=x onerror=alert(1)>");
  });

  test("anything else: a generic notification, nothing opened but the page", () => {
    for (const text of [
      undefined,
      "",
      "hello",
      message({ v: 2 }),
      message({ doc: "../x" }),
    ]) {
      expect(shownOf(text, en)).toEqual({
        title: "Collab Link",
        body: "A reply awaits yours.",
        tag: "oc:push",
      });
    }
  });

  test("a click opens this origin's document, never another address", () => {
    const scope = "https://collab.example/notes/";
    expect(clickTarget(scope, DOC)).toBe(
      `https://collab.example/notes/?doc=${DOC}`,
    );
    expect(clickTarget(scope, undefined)).toBe(scope);
    for (const doc of [
      "https://evil.example",
      "//evil.example",
      `${DOC}&k=1`,
    ]) {
      expect(clickTarget(scope, doc)).toBe(scope);
    }
  });
});
