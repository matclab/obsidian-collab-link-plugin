// @vitest-environment jsdom
//
// Another's text and the undo history (phase 17, decision 12; analysis
// 17d, I6), for the page's editor and for one a host provides as Obsidian
// builds its own: through any sequence of edits typed here, edits from
// another peer, undos and redos, the editor shows exactly its Loro text,
// and an undo never removes a character the other peer typed.
import { redo, undo } from "@codemirror/commands";
import { Transaction } from "@codemirror/state";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc } from "loro-crdt";
import { describe, test } from "vitest";
import { createDocumentEditor } from "./editor.js";
import { obsidianLike } from "./test-support/obsidian-like.js";

// Typed here: lower case; by the other peer: upper case.
const theirs = (text: string) => text.replace(/[^A-Z]/g, "").length;

describe("another's text and the undo history (property)", () => {
  for (const [name, provide] of [
    ["the page's editor", undefined],
    ["an editor a host provides", obsidianLike],
  ] as const) {
    test(
      `${name}: the editor shows Loro's text, an undo never removes another's`,
      () =>
        hegel.test((tc) => {
          const here = new LoroDoc();
          const peer = new LoroDoc();
          const editor = createDocumentEditor(
            document.createElement("div"),
            here,
            { ...(provide && { provide }) },
          );
          const { view } = editor;
          // The undo history groups what is typed within half a second.
          let clock = Date.now();
          const toPeer = () => peer.import(here.export({ mode: "update" }));
          const fromPeer = () => here.import(peer.export({ mode: "update" }));
          const position = (length: number) =>
            tc.draw(gs.integers({ minValue: 0, maxValue: length }));
          const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 30 }));
          for (let step = 0; step < steps; step++) {
            const act = tc.draw(
              gs.sampledFrom([
                "type",
                "erase",
                "pause",
                "peerTypes",
                "peerErases",
                "sync",
                "undo",
                "redo",
              ] as const),
            );
            const length = view.state.doc.length;
            if (act === "type") {
              view.dispatch({
                changes: {
                  from: position(length),
                  insert: tc.draw(gs.sampledFrom(["a", "bc", "d\n"])),
                },
                userEvent: "input.type",
                annotations: Transaction.time.of(clock),
              });
            } else if (act === "erase" && length > 0) {
              const from = position(length - 1);
              const to = tc.draw(
                gs.integers({ minValue: from + 1, maxValue: length }),
              );
              view.dispatch({
                changes: { from, to },
                userEvent: "delete",
                annotations: Transaction.time.of(clock),
              });
            } else if (act === "pause") {
              clock += 1000;
            } else if (act === "peerTypes" || act === "peerErases") {
              toPeer();
              const text = peer.getText("content");
              if (act === "peerTypes") {
                text.insert(
                  position(text.length),
                  tc.draw(gs.sampledFrom(["X", "YZ"])),
                );
              } else if (text.length > 0) {
                const from = position(text.length - 1);
                text.delete(from, 1);
              }
              peer.commit();
              fromPeer();
            } else if (act === "sync") {
              toPeer();
              fromPeer();
            } else if (act === "undo") {
              const before = theirs(view.state.doc.toString());
              undo(view);
              const after = theirs(view.state.doc.toString());
              if (after < before) {
                throw new Error(
                  `an undo removed another's text: ${before} → ${after}`,
                );
              }
            } else if (act === "redo") {
              redo(view);
            }
            const shown = view.state.doc.toString();
            const kept = here.getText("content").toString();
            if (shown !== kept) {
              throw new Error(
                `the editor shows ${JSON.stringify(shown)}, Loro holds ${JSON.stringify(kept)}`,
              );
            }
          }
          editor.destroy();
        }),
      // Heavy under the full suite's load.
      60_000,
    );
  }

  // Phase 17e: whatever a reader's editor is sent — a host's command or
  // plugin dispatching, an undo —, its text changes only by the other's.
  for (const [name, provide] of [
    ["the page's editor", undefined],
    ["an editor a host provides", obsidianLike],
  ] as const) {
    test(
      `${name}: a reader's text is the other's, whatever is dispatched`,
      () =>
        hegel.test((tc) => {
          const here = new LoroDoc();
          const peer = new LoroDoc();
          const editor = createDocumentEditor(
            document.createElement("div"),
            here,
            { readOnly: true, ...(provide && { provide }) },
          );
          const { view } = editor;
          const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 20 }));
          for (let step = 0; step < steps; step++) {
            const act = tc.draw(
              gs.sampledFrom(["dispatch", "undo", "peerTypes"] as const),
            );
            if (act === "dispatch") {
              const length = view.state.doc.length;
              const from = tc.draw(
                gs.integers({ minValue: 0, maxValue: length }),
              );
              const to = tc.draw(
                gs.integers({ minValue: from, maxValue: length }),
              );
              view.dispatch({
                changes: {
                  from,
                  to,
                  insert: tc.draw(gs.sampledFrom(["", "a"])),
                },
                userEvent: tc.draw(gs.sampledFrom(["input", "delete", "set"])),
              });
            } else if (act === "undo") {
              undo(view);
            } else {
              const text = peer.getText("content");
              text.insert(
                tc.draw(gs.integers({ minValue: 0, maxValue: text.length })),
                "X",
              );
              peer.commit();
              here.import(peer.export({ mode: "update" }));
            }
            const theirs = peer.getText("content").toString();
            const kept = here.getText("content").toString();
            if (kept !== theirs || view.state.doc.toString() !== kept) {
              throw new Error(
                `the reader's text ${JSON.stringify(kept)}, shown ${JSON.stringify(view.state.doc.toString())}, the other's ${JSON.stringify(theirs)}`,
              );
            }
          }
          editor.destroy();
        }),
      60_000,
    );
  }
});
