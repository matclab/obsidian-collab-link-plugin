/** The hints at the moment of surprise (ADR-0064, AC4 – AC7):
 * the markup shown again on the caret's line, in the formatted text; a
 * diagram, drawn only in Reading. Each once, opened by a move of the
 * caret by its user, one at a time; closed by its button, Escape, or the
 * caret leaving its line or block. A state of the editor's: no wait of
 * its own; what was seen is told to `remember` once shown. */
import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  Prec,
  StateEffect,
  StateField,
  type Transaction,
} from "@codemirror/state";
import { EditorView, keymap, showTooltip } from "@codemirror/view";
import { t } from "../i18n/index.js";
import { count } from "../perf/index.js";
import { formattedText, hidesMarkup } from "./live-preview.js";

export type Hint = "markup" | "diagram";

export interface FirstHintsOptions {
  /** Seen before, in this browser. */
  seen: ReadonlySet<string>;
  /** Told once a hint is shown (AC6). */
  remember(hint: Hint): void;
  /** The diagram's button: Reading (AC5). */
  toReading(): void;
}

interface Shown {
  hint: Hint;
  /** Its line or block: the caret out of it closes it. */
  from: number;
  to: number;
}

interface HintsState {
  seen: ReadonlySet<Hint>;
  shown: Shown | undefined;
}

const closeHint = StateEffect.define<null>();

/** The diagram block under `pos`, a ```mermaid fenced code (as the
 * preview draws it, `render.ts`). */
function diagramAt(state: EditorState, pos: number): Shown | undefined {
  for (
    let node: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null =
      syntaxTree(state).resolveInner(pos, 1);
    node;
    node = node.parent
  ) {
    if (node.name !== "FencedCode") continue;
    const info = node.getChild("CodeInfo");
    const language = info
      ? state.doc.sliceString(info.from, info.to).trim().split(/\s+/)[0]
      : "";
    return language === "mermaid"
      ? { hint: "diagram", from: node.from, to: node.to }
      : undefined;
  }
  return undefined;
}

function opened(tr: Transaction, seen: ReadonlySet<Hint>): Shown | undefined {
  count("hints.check");
  const state = tr.startState;
  const head = tr.newSelection.main.head;
  if (!seen.has("markup") && state.facet(formattedText) && !state.readOnly) {
    const line = state.doc.lineAt(head);
    if (hidesMarkup(syntaxTree(state), state.doc, line.from, line.to)) {
      return { hint: "markup", from: line.from, to: line.to };
    }
  }
  if (!seen.has("diagram")) return diagramAt(state, head);
  return undefined;
}

function hintsField(options: FirstHintsOptions) {
  const field: StateField<HintsState> = StateField.define<HintsState>({
    create: () => ({
      seen: new Set(
        (["markup", "diagram"] as const).filter((h) => options.seen.has(h)),
      ),
      shown: undefined,
    }),
    update(value, tr) {
      let shown = value.shown;
      if (shown && tr.docChanged) {
        shown = {
          ...shown,
          from: tr.changes.mapPos(shown.from, -1),
          to: tr.changes.mapPos(shown.to, 1),
        };
      }
      const head = tr.newSelection.main.head;
      if (
        shown &&
        (tr.effects.some((e) => e.is(closeHint)) ||
          head < shown.from ||
          head > shown.to)
      ) {
        // Closed: the next waits for the next move.
        return { ...value, shown: undefined };
      }
      if (
        !shown &&
        tr.selection &&
        !tr.docChanged &&
        tr.isUserEvent("select") &&
        value.seen.size < 2
      ) {
        const next = opened(tr, value.seen);
        if (next)
          return { seen: new Set([...value.seen, next.hint]), shown: next };
      }
      return shown === value.shown ? value : { ...value, shown };
    },
    provide: (f) =>
      showTooltip.compute([f], (state) => {
        const shown = state.field(f).shown;
        if (!shown) return null;
        return {
          pos: state.doc.lineAt(Math.max(shown.from, 0)).from,
          above: false,
          create: (view) => ({ dom: hintDom(view, shown.hint, options) }),
        };
      }),
  });
  return field;
}

function hintDom(
  view: EditorView,
  hint: Hint,
  options: FirstHintsOptions,
): HTMLElement {
  const close = () => view.dispatch({ effects: closeHint.of(null) });
  const dom = document.createElement("div");
  dom.className = "first-hint";
  dom.setAttribute("role", "status");
  const text = document.createElement("p");
  text.textContent = hint === "markup" ? t().hintMarkup : t().hintDiagram;
  const actions = document.createElement("div");
  actions.className = "first-hint-actions";
  if (hint === "diagram") {
    const reading = document.createElement("button");
    reading.className = "quiet";
    reading.textContent = t().preview;
    reading.addEventListener("click", () => {
      close();
      options.toReading();
    });
    actions.append(reading);
  }
  const done = document.createElement("button");
  done.textContent = t().welcomeDone;
  done.addEventListener("click", close);
  actions.append(done);
  dom.append(text, actions);
  return dom;
}

/** The first hints, those not yet `seen`; none once both are (AC7). */
export function firstHints(options: FirstHintsOptions): Extension {
  if (options.seen.has("markup") && options.seen.has("diagram")) return [];
  const field = hintsField(options);
  return [
    field,
    EditorView.updateListener.of((update) => {
      // Absent before the transaction that adds the hints.
      const before = update.startState.field(field, false)?.shown;
      const now = update.state.field(field).shown;
      if (now && now !== before && now.hint !== before?.hint) {
        options.remember(now.hint);
      }
    }),
    Prec.highest(
      keymap.of([
        {
          key: "Escape",
          run: (view) => {
            if (!view.state.field(field).shown) return false;
            view.dispatch({ effects: closeHint.of(null) });
            return true;
          },
        },
      ]),
    ),
  ];
}
