// @vitest-environment jsdom
//
// Uploading images (ADR-0057 §8, analysis 31): files pasted at a slot,
// the server's answers in an order the test draws, others' edits around
// the slot, a cancel, the view closed — at any step (AGENTS.md §1.6).
// Checked: a reference goes in only for an image the server stored, once,
// at its slot (just before the `|` the slot was before), never after the
// view closed nor once it may not write; an upload's line shows while it
// runs and never after; refusals are said.
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import {
  type PreparedImage,
  generateKey,
  imageFormat,
  isAttachmentId,
} from "../../../lib/src/index.js";
import { holdPosition, imageInsertion } from "../../editor/image-insertion.js";
import { t } from "../../i18n/index.js";
import type { AttachedImages } from "../../view-model/attached-images.js";
import { altOf, createImageUploader } from "./image-upload.js";

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface Upload {
  id: string;
  answer: (status: number | "network") => void;
  signal: AbortSignal | undefined;
}

describe("uploading images", () => {
  test(
    "whatever the server answers, and when, and whatever happens around",
    () =>
      hegel.testAsync(
        async (tc) => {
          const key = await generateKey();
          const view = new EditorView({
            state: EditorState.create({
              doc: "ab|cd",
              extensions: [imageInsertion()],
            }),
            parent: document.createElement("div"),
          });
          const status = document.createElement("div");
          const notices: string[] = [];
          const added: string[] = [];
          const uploads: Upload[] = [];
          const stored = new Set<string>();
          const attached = {
            add: (id: string) => added.push(id),
          } as unknown as AttachedImages;
          let closed = false;
          let prepared = 0;
          const wrong: string[] = [];
          const inserted: string[] = [];
          view.dispatch({
            effects: (
              await import("@codemirror/state")
            ).StateEffect.appendConfig.of(
              EditorView.updateListener.of((update) => {
                update.changes.iterChanges((_a, _b, from, to, text) => {
                  const value = text.toString();
                  if (!value.startsWith("![")) return;
                  // Recorded, not thrown: CodeMirror catches a listener's.
                  if (closed) wrong.push(`${value} after the view closed`);
                  const after = update.state.sliceDoc(to, to + 1);
                  if (after !== "|")
                    wrong.push(`${value} before ${after}, not at its slot`);
                  inserted.push(
                    value.slice(value.indexOf("attachment:") + 11, -1),
                  );
                  if (from >= to) wrong.push("an empty reference");
                });
              }),
            ),
          });
          const uploader = createImageUploader({
            apiBase: "https://s",
            documentId: "doc",
            key,
            roleSecret: () => "edit.x",
            fetch: (url, init) =>
              new Promise((resolve, reject) => {
                const id = url.slice(url.lastIndexOf("/") + 1);
                const signal = init?.signal ?? undefined;
                signal?.addEventListener("abort", () =>
                  reject(new DOMException("aborted", "AbortError")),
                );
                uploads.push({
                  id,
                  signal,
                  answer: (answer) => {
                    if (answer === "network") reject(new TypeError("offline"));
                    else {
                      if (answer === 201) stored.add(id);
                      resolve(new Response(null, { status: answer }));
                    }
                  },
                });
              }),
            imageBytes: 1000,
            attached,
            notify: (message) => notices.push(message),
            status,
            chooseFiles: async () => [],
            // Deterministic: resolved in a microtask, as everything here but
            // the server's answers, which the test gives.
            prepare: async (_key, _doc, bytes) => {
              const format = imageFormat(bytes);
              if (format === null) return "not-an-image";
              const id = `${String(prepared++).padStart(21, "A")}A`;
              return {
                attachmentId: id,
                format,
                bytes,
                blob: bytes,
              } satisfies PreparedImage;
            },
          });
          const files = tc
            .draw(
              gs.arrays(gs.sampledFrom(["png", "pdf", "big"]), {
                minSize: 1,
                maxSize: 4,
              }),
            )
            .map((kind, i) => {
              const bytes =
                kind === "png"
                  ? PNG
                  : kind === "big"
                    ? new Uint8Array(2000)
                    : new TextEncoder().encode("%PDF");
              // Read in a microtask, not by jsdom's reader.
              return {
                name: `f${i}].${kind}`,
                size: bytes.length,
                arrayBuffer: async () => bytes.slice().buffer,
              } as unknown as File;
            });
          uploader.insert(view, files, holdPosition(view, 2));

          for (let step = 0; step < 24; step++) {
            await settle();
            expect(wrong).toEqual([]);
            expect(
              status.querySelectorAll(".image-upload").length,
            ).toBeLessThanOrEqual(1);
            const act = tc.draw(gs.integers({ minValue: 0, maxValue: 7 }));
            const open = uploads.filter((u) => !u.signal?.aborted);
            if ((act <= 1 || act === 3) && open.length > 0) {
              const upload = tc.draw(gs.sampledFrom(open));
              uploads.splice(uploads.indexOf(upload), 1);
              upload.answer(
                tc.draw(
                  gs.sampledFrom<number | "network">([
                    201,
                    201,
                    507,
                    507,
                    404,
                    403,
                    413,
                    "network",
                  ]),
                ),
              );
            } else if (act === 2 || act === 5) {
              // Another's edit, before the slot most often: where a slot not
              // followed would show.
              const at = tc.draw(
                gs.sampledFrom([
                  0,
                  1,
                  2,
                  view.state.doc.length,
                  view.state.selection.main.head,
                ]),
              );
              if (!closed)
                view.dispatch({ changes: { from: at, insert: "x" } });
            } else if (act === 7 && open.length > 0 && !closed) {
              // One gesture (AGENTS.md §1.6): another's edit before the slot,
              // then the server stores — what a slot not followed would miss.
              view.dispatch({ changes: { from: 0, insert: "y" } });
              const upload = tc.draw(gs.sampledFrom(open));
              uploads.splice(uploads.indexOf(upload), 1);
              upload.answer(201);
            } else if (act === 4 && status.querySelector("button")) {
              status.querySelector("button")?.dispatchEvent(new Event("click"));
            } else if (
              act === 6 &&
              !closed &&
              tc.draw(gs.integers({ minValue: 0, maxValue: 9 })) === 0
            ) {
              uploader.destroy();
              closed = true;
            }
          }
          // Everything answers, stored.
          while (!closed) {
            await settle();
            const upload = uploads.shift();
            if (!upload) {
              await settle();
              if (uploads.length === 0) break;
              continue;
            }
            // Cancelled, its request is gone: no answer reaches it.
            if (!upload.signal?.aborted) upload.answer(201);
          }
          await settle();
          await settle();
          expect(wrong).toEqual([]);
          for (const id of inserted) {
            expect(isAttachmentId(id)).toBe(true);
            expect(stored.has(id), `${id} cited, not stored`).toBe(true);
          }
          expect(new Set(inserted).size).toBe(inserted.length);
          if (!closed) {
            expect([...stored].sort()).toEqual([...inserted].sort());
            expect(added.sort()).toEqual([...inserted].sort());
          }
          expect(status.querySelectorAll(".image-upload").length).toBe(0);
          const pdfs = files.filter((file) =>
            file.name.endsWith(".pdf"),
          ).length;
          if (!closed) {
            expect(notices.filter((n) => n.includes("PNG, JPEG")).length).toBe(
              pdfs,
            );
          }
          view.destroy();
        },
        { testCases: 80 },
      ),
    120_000,
  );

  test("a file's name as an image's text", () => {
    expect(altOf("photo.png")).toBe("photo");
    expect(altOf("a [b]\\c\n.jpeg")).toBe("a b c");
    expect(altOf(".png")).toBe("image");
    expect(t().imageTooLarge("x", 9.9)).toContain("9.9");
  });
});
