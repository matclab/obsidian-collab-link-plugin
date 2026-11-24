import type { LoroDoc } from "loro-crdt";
import { flushSync, mount, unmount } from "svelte";
import {
  type Authorship,
  attachAuthorship,
  authorMarkAt,
  authorMarks,
} from "../../editor/authorship.js";
import type { DocumentEditor } from "../../editor/editor.js";
import { AuthorNames } from "../../history/author-names.js";
import {
  type Person,
  insertionAt,
  personOf,
} from "../../history/authorship.js";
import { formatShortDate, t } from "../../i18n/index.js";
import { count } from "../../perf/index.js";
import type { Preview } from "../reading/preview.js";
import type { ViewSwitch } from "../reading/view-switch.js";
import { NEVER, type ScreenQuery } from "../view-width.js";
import Legend from "./AuthorshipLegend.svelte";

/** A person as the legend shows it. */
export interface LegendPerson {
  key: string;
  /** `undefined`: unknown. */
  name: string | undefined;
  /** The color's class, as the text's marks carry it. */
  color: string;
}

export interface AuthorshipView {
  /** The switch, for tests and the trace. */
  readonly toggle: HTMLButtonElement;
  readonly authorship: Authorship;
  destroy(): void;
}

/** "Who wrote" (ADR-0059 §4): a switch among the view's toggles, off at
 * each opening; on, the text tinted by person (`editor/authorship.ts`),
 * the annotations' backgrounds given up (`authorship-on` on `parent`), and
 * a legend over the text, outside it: the persons of the text shown, the
 * one at the pointer — over the text —, else at the caret, brought forward
 * with its date. Hidden in History. The legend follows the editor once per
 * `schedule` (a microtask), never while off. */
export function attachAuthorshipView(options: {
  editor: DocumentEditor;
  contentDoc: LoroDoc;
  annotationsDoc: LoroDoc;
  /** The view's element: told `authorship-on`. */
  parent: HTMLElement;
  views: Pick<ViewSwitch, "bar" | "mode" | "onMode"> & {
    /** Its blocks get a bar each while shown (ADR-0059 §6). */
    preview?: Pick<Preview, "visible" | "root" | "onRendered">;
  };
  /** The view is narrow (default: never, unmeasured). */
  narrow?: ScreenQuery;
  schedule?: (run: () => void) => void;
  /** Where the legend sticks, under the view's header (default: 0). */
  readingTop?: () => number;
}): AuthorshipView {
  const { editor, contentDoc, parent, views } = options;
  const { view } = editor;
  const schedule = options.schedule ?? ((run) => queueMicrotask(run));
  const narrow = options.narrow ?? NEVER;
  const names = new AuthorNames(options.annotationsDoc, schedule);

  const toggle = document.createElement("button");
  toggle.className = "authorship-toggle quiet";
  toggle.textContent = t().whoWrote;
  toggle.title = t().whoWroteHelp;
  views.bar.append(toggle);
  const place = document.createElement("div");
  place.className = "authorship-legend";
  views.bar.after(place);
  const legend = mount(Legend, { target: place, props: {} });

  const { preview } = views;
  let pointed: number | undefined;
  /** The preview's block under the pointer. */
  let pointedBlock: HTMLElement | undefined;
  /** The bars follow the preview's renderings, whose lines are those of
   * the text then, and the marks' changes without a change of the text:
   * never a keystroke's, whose lines the next rendering brings. */
  let barsStale = false;
  let pending = false;
  const previewing = () => (preview?.visible ?? false) && view.dom.hidden;
  const render = () => {
    pending = false;
    if (!authorship.on()) return;
    count("authorship.legend");
    const known = names.current();
    const shown = previewing()
      ? [{ from: 0, to: view.state.doc.length }]
      : view.visibleRanges;
    const persons = new Map<string, LegendPerson>();
    for (const { from, to } of shown) {
      for (const mark of authorMarks(view.state, from, to)) {
        const person = personOf(mark.peer, known);
        if (!persons.has(person.key)) {
          persons.set(person.key, {
            ...person,
            color: colorOf(mark.className),
          });
        }
      }
    }
    if (barsStale && preview?.visible) {
      barsStale = false;
      drawBars(preview.root);
    }
    let designated: (LegendPerson & { when?: string })[] = [];
    if (pointedBlock?.isConnected) {
      designated = sharesOf(pointedBlock).map(({ color, person }) => ({
        ...person,
        color,
      }));
    } else if (!previewing()) {
      const head = view.state.selection.main.head;
      const at = pointed ?? (head > 0 ? head - 1 : head);
      const mark = authorMarkAt(view.state, at);
      if (mark) {
        const when = insertionAt(contentDoc, at)?.at;
        designated = [
          {
            ...personOf(mark.peer, known),
            color: colorOf(mark.className),
            ...(when !== undefined && { when: formatShortDate(when * 1000) }),
          },
        ];
      }
    }
    place.style.top = `${options.readingTop?.() ?? 0}px`;
    legend.show(
      [...persons.values()].sort(byColor),
      designated,
      narrow.matches(),
    );
    flushSync();
  };
  const later = () => {
    if (pending) return;
    pending = true;
    schedule(render);
  };
  const authorship = attachAuthorship(view, contentDoc, names, {
    schedule,
    onUpdate(update) {
      if (!update.docChanged) barsStale = true;
      later();
    },
  });

  /** The persons of a block, by the share of its text, in their colors'
   * order; its lines from the rendering (`data-line`, `data-line-end`). */
  const sharesOf = (block: HTMLElement) => {
    const { doc } = view.state;
    const first = Number(block.dataset.line);
    const end = Number(block.dataset.lineEnd);
    if (!Number.isInteger(first) || first >= doc.lines || end <= first) {
      return [];
    }
    const from = doc.line(first + 1).from;
    const to = doc.line(Math.min(end, doc.lines)).to;
    const known = names.current();
    const shares = new Map<
      string,
      { color: string; person: Person; length: number }
    >();
    for (const mark of authorMarks(view.state, from, to)) {
      const color = colorOf(mark.className);
      const length = Math.min(mark.to, to) - Math.max(mark.from, from);
      const held = shares.get(color);
      if (held) held.length += length;
      else
        shares.set(color, {
          color,
          person: personOf(mark.peer, known),
          length,
        });
    }
    return [...shares.values()].sort((x, y) =>
      byColor({ ...x.person, color: x.color }, { ...y.person, color: y.color }),
    );
  };
  const drawBars = (root: HTMLElement) => {
    count("authorship.bars");
    for (const block of Array.from(root.children) as HTMLElement[]) {
      if (block.dataset.line === undefined) continue;
      const shares = sharesOf(block);
      const total = shares.reduce((sum, { length }) => sum + length, 0);
      let at = 0;
      const stops = shares.map(({ color, length }) => {
        const from = at;
        at += (100 * length) / total;
        return `var(--${color.replace("cm-", "")}-line) ${from.toFixed(2)}% ${at.toFixed(2)}%`;
      });
      const authors =
        stops.length > 0 ? `linear-gradient(${stops.join(", ")})` : "";
      if ((block.dataset.authors ?? "") === authors) continue;
      if (authors) {
        block.dataset.authors = authors;
        block.style.setProperty("--authors", authors);
      } else {
        delete block.dataset.authors;
        block.style.removeProperty("--authors");
      }
    }
  };

  const onPointer = (event: MouseEvent) => {
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    const next = pos ?? undefined;
    if (next === pointed) return;
    pointed = next;
    later();
  };
  const onLeave = () => {
    if (pointed === undefined) return;
    pointed = undefined;
    later();
  };
  const onBlock = (event: MouseEvent) => {
    let block = event.target as HTMLElement | null;
    while (block && block.parentElement !== preview?.root) {
      block = block.parentElement;
    }
    const next = block?.dataset.line === undefined ? undefined : block;
    if (next === pointedBlock) return;
    pointedBlock = next ?? undefined;
    later();
  };
  const onBlockLeave = () => {
    if (pointedBlock === undefined) return;
    pointedBlock = undefined;
    later();
  };
  const listen = (on: boolean) => {
    const content = view.contentDOM;
    const root = preview?.root;
    if (on) {
      content.addEventListener("mousemove", onPointer);
      content.addEventListener("mouseleave", onLeave);
      root?.addEventListener("mouseover", onBlock);
      root?.addEventListener("mouseleave", onBlockLeave);
    } else {
      content.removeEventListener("mousemove", onPointer);
      content.removeEventListener("mouseleave", onLeave);
      root?.removeEventListener("mouseover", onBlock);
      root?.removeEventListener("mouseleave", onBlockLeave);
    }
  };
  const apply = () => {
    const on = authorship.on();
    toggle.setAttribute("aria-pressed", String(on));
    toggle.hidden = views.mode() === "history";
    place.hidden = !on || views.mode() === "history";
    parent.classList.toggle("authorship-on", on);
    preview?.root.classList.toggle("authorship-on", on);
    // The whole text read once while the preview shows: its bars.
    authorship.setWhole(on && (preview?.visible ?? false));
    if (on) {
      barsStale = true;
      later();
    }
  };
  toggle.addEventListener("click", () => {
    const on = !authorship.on();
    authorship.setOn(on);
    listen(on);
    if (!on) {
      pointed = undefined;
      pointedBlock = undefined;
    }
    apply();
  });
  preview?.onRendered(() => {
    if (!authorship.on()) return;
    barsStale = true;
    later();
  });
  const stopNames = names.subscribe(later);
  views.onMode(apply);
  narrow.onChange(later);
  apply();
  return {
    toggle,
    authorship,
    destroy() {
      stopNames();
      authorship.destroy();
      names.destroy();
      listen(false);
      void unmount(legend);
    },
  };
}

/** `cm-author-3` of `cm-author cm-author-3`. */
const colorOf = (className: string) =>
  className.split(" ").find((name) => name !== "cm-author") ?? "";

/** By color, unknown last. */
function byColor(x: LegendPerson, y: LegendPerson): number {
  const rank = (person: LegendPerson) =>
    Number(
      /cm-author-(\d+)/.exec(person.color)?.[1] ?? Number.POSITIVE_INFINITY,
    );
  return rank(x) - rank(y) || (x.name ?? "").localeCompare(y.name ?? "");
}
