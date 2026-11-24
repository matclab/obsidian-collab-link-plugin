import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { RenderOptions } from "pele";
import { remoteCaretPositions } from "../../editor/remote-cursors.js";
import { t } from "../../i18n/index.js";
import { count, span } from "../../perf/index.js";
import {
  type GrantedImage,
  remoteImageSources,
  renderMarkdownBlocks,
} from "../../render/index.js";
import type { AttachedImages } from "../../view-model/attached-images.js";
import {
  KATEX_OPTIONS,
  type KatexModule,
  loadKatex,
} from "../../view-model/katex.js";
import type { RemoteImages } from "../../view-model/remote-images.js";
import { DIAGRAM_OPTIONS, DiagramRefused, checkedDiagram } from "./diagram.js";

/** How long the text must stay unchanged before it is rendered again. */
export const RENDER_DELAY_MS = 150;

/** What the preview needs of Pele (ADR-0042): `pele/lazy`, each diagram
 * type loaded on first use. */
export interface DiagramModule {
  render(source: string, options: RenderOptions): Promise<{ svg: string }>;
  /** Whether `error` says the source cannot be drawn — not a type that
   * failed to load, which is tried again at the next rendering. */
  refuses(error: unknown): boolean;
}

/** Where KaTeX and Pele come from: loaded on first need (ADR-0021 §6). */
export interface PreviewLoaders {
  katex: () => Promise<KatexModule>;
  diagrams: () => Promise<DiagramModule>;
}

// Once per page, however many previews (the text, a past version).
let diagramsLoading: Promise<DiagramModule> | undefined;

const defaultLoaders: PreviewLoaders = {
  katex: loadKatex,
  diagrams: () => {
    diagramsLoading ??= import("pele/lazy").then(
      ({ renderAsync, PeleError }) => ({
        render: renderAsync,
        refuses: (error) => error instanceof PeleError,
      }),
    );
    diagramsLoading.catch(() => {
      diagramsLoading = undefined;
    });
    return diagramsLoading;
  },
};

/** Whether `error` says this diagram cannot be drawn: Pele refuses its
 * source, or the check refuses what Pele drew. */
function refusal(engine: DiagramModule, error: unknown): boolean {
  return error instanceof DiagramRefused || engine.refuses(error);
}

// Unique on the page: a diagram's ids (its title, its description) do not
// meet another view's. Two copies of one source
// share theirs.
let diagramIds = 0;

/** How a diagram is drawn in `placeholder`: our options, and the font its
 * CSS gives (`--pele-font`, its size), which Pele measures labels with. */
function diagramOptions(placeholder: Element): RenderOptions {
  const style = getComputedStyle(placeholder);
  const fontFamily = style.getPropertyValue("--pele-font").trim();
  const fontSize = Number.parseFloat(style.fontSize);
  return {
    ...DIAGRAM_OPTIONS,
    idPrefix: `diagram-${diagramIds++}`,
    ...(fontFamily ? { fontFamily } : {}),
    ...(fontSize > 0 ? { fontSize } : {}),
  };
}

function showError(placeholder: Element, error: unknown): void {
  const line = document.createElement("div");
  line.className = "render-error";
  line.textContent = error instanceof Error ? error.message : String(error);
  placeholder.prepend(line);
}

/** Replaces `root`'s children by those `html` renders, keeping each child
 * whose own rendering is unchanged: kept in place, never detached — a
 * diagram's frame does not reload, a formula is not reinserted
 * (ADR-0021 §6). Matched in order, so a kept child never moves. `origins`
 * holds the rendering each child came from. */
function reconcile(
  root: Element,
  html: string,
  origins: WeakMap<Node, string>,
): void {
  const template = document.createElement("template");
  template.innerHTML = html;
  // A task's box, named for a screen reader, as the editor's.
  for (const box of Array.from(
    template.content.querySelectorAll("input[type=checkbox]"),
  ))
    box.setAttribute("aria-label", t().task);
  // Blocks only: the line breaks between them, all alike, would match
  // ahead of their place.
  const available = new Map<string, Element[]>();
  for (const node of Array.from(root.children)) {
    const key = origins.get(node);
    if (key === undefined) continue;
    const nodes = available.get(key) ?? [];
    nodes.push(node);
    available.set(key, nodes);
  }
  const position = new Map(
    Array.from(root.children, (node, at) => [node, at] as const),
  );
  let last = -1;
  const wanted: Element[] = [];
  for (const node of Array.from(template.content.children)) {
    const key = node.outerHTML;
    const candidates = available.get(key) ?? [];
    const at = candidates.findIndex((old) => (position.get(old) ?? -1) > last);
    const kept = at >= 0 ? candidates.splice(0, at + 1).pop() : undefined;
    if (kept) {
      last = position.get(kept) ?? last;
      wanted.push(kept);
    } else {
      origins.set(node, key);
      wanted.push(node);
    }
  }
  const keep = new Set<Node>(wanted);
  for (const node of Array.from(root.childNodes)) {
    if (!keep.has(node)) node.remove();
  }
  let next: Element | null = root.firstElementChild;
  for (const node of wanted) {
    if (node === next) next = next.nextElementSibling;
    else root.insertBefore(node, next);
  }
}

/** The host an image is loaded from, as its case and caption name it. */
function hostOf(src: string): string {
  try {
    return new URL(src).hostname;
  } catch {
    return src;
  }
}

/** A remote image's case (ADR-0055 §3): its link, then its domain and a
 * button to show it — or, granted and under a cursor, that it waits
 * (§12). Filled again at each rendering: the grant may have changed. */
function fillCase(box: HTMLElement, images: RemoteImages): void {
  const src = box.dataset.imageSource ?? "";
  const link = box.querySelector("a.remote-image");
  // Not loaded (§8): the link alone, as before the grant.
  if (images.failed(src) && link) {
    box.replaceWith(link);
    return;
  }
  box.replaceChildren(...(link ? [link] : []));
  if (images.granted(src)) {
    const waiting = document.createElement("span");
    waiting.className = "remote-image-waiting";
    waiting.textContent = t().remoteImageWaiting;
    box.append(waiting);
    return;
  }
  const host = document.createElement("span");
  host.className = "remote-image-host";
  host.textContent = hostOf(src);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "quiet remote-image-grant";
  button.textContent = t().remoteImageShow;
  button.setAttribute("aria-label", t().remoteImageShowLabel(hostOf(src)));
  box.append(host, button);
}

function formulaKey(placeholder: HTMLElement): string {
  const display = placeholder.classList.contains("math-display");
  return `${display ? "D" : "I"}${placeholder.dataset.tex ?? ""}`;
}

export interface Preview {
  readonly visible: boolean;
  /** The rendered text: each top-level block carries its source lines
   * (`data-line`, `data-line-end`). */
  readonly root: HTMLElement;
  /** Called after each rendering, once its blocks are in place. */
  onRendered(listener: () => void): void;
  /** Called with the decoded id of an in-document link that no element of
   * the rendering has: a heading, which the view finds. */
  onAnchor(listener: (id: string) => void): void;
  show(): void;
  hide(): void;
  /** Resolves once the formulas and diagrams of what is shown are drawn,
   * or given up for a newer rendering. */
  settled(): Promise<void>;
  /** Called with the text's remote images the page may load, after each
   * rendering, or hidden, after a burst (ADR-0055 §4). */
  onImages(listener: (sources: readonly string[]) => void): void;
}

/** What the preview needs to load a remote image (ADR-0055): the reader's
 * grants, and the lines the carets are on, from 0 (§12); and the view's
 * attached images (ADR-0057 §8). */
export interface PreviewImages {
  images?: RemoteImages;
  cursorLines?: () => readonly number[];
  attached?: AttachedImages;
}

/** An attached image's slot (ADR-0057 §8): the image once shown, else
 * its text and what keeps it; `true` once it is final. */
function fillAttached(slot: HTMLElement, images: AttachedImages): boolean {
  const state = images.state(slot.dataset.attachment ?? "");
  const text = slot.querySelector(".attached-image-text");
  if (state.kind === "shown") {
    const image = document.createElement("img");
    image.alt = text?.textContent ?? "";
    image.src = state.url;
    slot.replaceChildren(image);
    return true;
  }
  const note = document.createElement("span");
  note.className = "attached-image-note";
  note.textContent = {
    loading: t().attachedImageLoading,
    absent: t().attachedImageAbsent,
    unreadable: t().attachedImageUnreadable,
    unavailable: t().attachedImageUnavailable,
  }[state.kind];
  slot.replaceChildren(...(text ? [text] : []), note);
  slot.classList.toggle("attached-image-loading", state.kind === "loading");
  return state.kind !== "loading";
}

/** The rendered view of the text (ADR-0021 §1): it follows the editor's
 * view, which already mirrors Loro, local and remote; hidden, it costs
 * nothing. */
export function createPreview(
  container: Element,
  view: EditorView,
  loaders: Partial<PreviewLoaders> = {},
  images?: RemoteImages,
  attached?: AttachedImages,
): Preview {
  // The reader's carets and the others' (ADR-0055 §12).
  const cursorLines = () => {
    const { state } = view;
    const at = [
      ...state.selection.ranges.flatMap((range) => [range.from, range.to]),
      ...remoteCaretPositions(state),
    ];
    return at.map((position) => state.doc.lineAt(position).number - 1);
  };
  const preview = createTextPreview(
    container,
    () => view.state.doc.toString(),
    loaders,
    {
      ...(images && { images, cursorLines }),
      ...(attached && { attached }),
    },
  );
  view.dispatch({
    effects: StateEffect.appendConfig.of(
      EditorView.updateListener.of((update) => {
        if (update.docChanged) preview.changed();
        else if (
          update.selectionSet ||
          remoteCaretPositions(update.startState) !==
            remoteCaretPositions(update.state)
        ) {
          preview.cursorsMoved();
        }
      }),
    ),
  });
  return preview;
}

export interface TextPreview extends Preview {
  /** `text()` may have changed: rendered again after a pause, if shown. */
  changed(): void;
  /** A caret moved: rendered again if an image waited for it (§12). */
  cursorsMoved(): void;
}

/** A rendered view of whatever `text()` returns: the editor's text, or a
 * past version. Each rendering has a generation: what is filled
 * in after an `await` (formulas, diagrams) is only written if its
 * generation is still the current one (docs/phase-6-*.md, step 4,
 * interleavings). */
export function createTextPreview(
  container: Element,
  text: () => string,
  loaders: Partial<PreviewLoaders> = {},
  remote?: PreviewImages,
): TextPreview {
  const load = { ...defaultLoaders, ...loaders };
  const images = remote?.images;
  const content = document.createElement("div");
  content.className = "preview";
  content.hidden = true;
  container.append(content);
  const anchors: ((id: string) => void)[] = [];
  // An in-document link would replace the fragment, which holds the key
  // and the role secret (ADR-0021 §3): scroll to its target instead.
  content.addEventListener("click", (event) => {
    // A task's box is read only (render.ts), a key's Space included.
    if ((event.target as Element | null)?.matches?.("input[type=checkbox]")) {
      event.preventDefault();
      return;
    }
    const link = (event.target as Element | null)?.closest?.("a");
    const href = link?.getAttribute("href");
    if (!href?.startsWith("#")) return;
    event.preventDefault();
    let id = href.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      // a malformed escape: the id as written
    }
    const target = Array.from(content.querySelectorAll("[id]")).find(
      (element) => element.id === id,
    );
    if (target) target.scrollIntoView();
    else for (const listener of anchors) listener(id);
  });
  let visible = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let filling: Promise<void> = Promise.resolve();
  let katex: Promise<KatexModule> | undefined;
  let pele: Promise<DiagramModule> | undefined;
  const origins = new WeakMap<Node, string>();
  const formulas = new Map<string, string>();
  // A diagram's outcome by source, refusals included (no retry per burst).
  const diagrams = new Map<string, Promise<Element>>();
  const rendered: (() => void)[] = [];
  const imageListeners: ((sources: readonly string[]) => void)[] = [];
  // What a remote image needs (ADR-0055 §12): the sources shown in this
  // view, which stay; the blocks where one waits for a caret to leave.
  const shownSources = new Set<string>();
  // Each waiting image's lines: its block, its address's definitions.
  let waiting: (readonly (readonly [number, number])[])[] = [];
  const caretIn = (lines: readonly (readonly [number, number])[]) => {
    const carets = remote?.cursorLines?.() ?? [];
    return lines.some(([first, end]) =>
      carets.some((line) => first <= line && line < end),
    );
  };
  const tellImages = (sources: readonly string[]) => {
    for (const listener of imageListeners) listener(sources);
  };

  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  // Hidden, the banner still counts the text's images (ADR-0055 §4).
  const scan = () => {
    timer = undefined;
    tellImages(remoteImageSources(text()));
  };

  if (images) {
    // A grant shows at once what it grants (one rendering, §3, §4).
    images.subscribe(() => {
      if (visible) render();
    });
    // Not loaded (§8): its link again, through the grants.
    content.addEventListener(
      "error",
      (event) => {
        const image = event.target as Element | null;
        if (image?.localName !== "img") return;
        const src = image.getAttribute("src") ?? "";
        if (image.closest(".remote-image-shown")) images.markFailed(src);
      },
      true,
    );
    content.addEventListener("click", (event) => {
      const button = (event.target as Element | null)?.closest?.(
        "button.remote-image-grant",
      );
      const box = button?.closest<HTMLElement>(".remote-image-case");
      if (box?.dataset.imageSource) images.grantImage(box.dataset.imageSource);
    });
  }

  const fillImages = () => {
    if (!images) return;
    for (const shown of Array.from(
      content.querySelectorAll<HTMLElement>(".remote-image-shown"),
    )) {
      const src = shown.querySelector("img")?.getAttribute("src") ?? "";
      shownSources.add(src);
      if (shown.querySelector(".remote-image-from")) continue;
      const from = document.createElement("span");
      from.className = "remote-image-from";
      from.textContent = t().remoteImageFrom(hostOf(src));
      shown.append(from);
    }
    for (const box of Array.from(
      content.querySelectorAll<HTMLElement>(".remote-image-case"),
    )) {
      fillCase(box, images);
    }
  };

  // Shown at once if known; filled again, alone, as each one arrives —
  // never a rendering more (AGENTS.md §6).
  const attached = remote?.attached;
  const fillAttachedImages = (ids?: readonly string[]) => {
    if (!attached) return;
    for (const slot of Array.from(
      content.querySelectorAll<HTMLElement>(
        ".attached-image:not([data-drawn])",
      ),
    )) {
      if (ids && !ids.includes(slot.dataset.attachment ?? "")) continue;
      count("preview.attached-image");
      if (fillAttached(slot, attached)) slot.dataset.drawn = "";
    }
  };
  attached?.subscribe((ids) => {
    if (visible) fillAttachedImages(ids);
  });

  const fillFormulas = async (current: number) => {
    const placeholders = content.querySelectorAll<HTMLElement>(
      ".math:not([data-drawn])",
    );
    if (placeholders.length === 0) return;
    katex ??= load.katex();
    let engine: KatexModule;
    try {
      engine = await katex;
    } catch (error) {
      katex = undefined; // tried again at the next rendering
      console.warn("KaTeX", error);
      return;
    }
    if (current !== generation) return;
    for (const placeholder of Array.from(placeholders)) {
      const tex = placeholder.dataset.tex ?? "";
      const displayMode = placeholder.classList.contains("math-display");
      const key = formulaKey(placeholder);
      let html = formulas.get(key);
      if (html === undefined) {
        count("katex.render");
        html = engine.renderToString(tex, { ...KATEX_OPTIONS, displayMode });
        formulas.set(key, html);
      }
      placeholder.innerHTML = html;
      placeholder.dataset.drawn = "";
    }
  };

  // The caches keep what the text has now, not every version typed.
  const forgetAbsent = (root: Element) => {
    const keep = (selector: string, key: (element: HTMLElement) => string) =>
      new Set(Array.from(root.querySelectorAll<HTMLElement>(selector), key));
    const formulaKeys = keep(".math", formulaKey);
    for (const key of formulas.keys()) {
      if (!formulaKeys.has(key)) formulas.delete(key);
    }
    const sources = keep(".mermaid", (element) => element.dataset.source ?? "");
    for (const source of diagrams.keys()) {
      if (!sources.has(source)) diagrams.delete(source);
    }
  };

  // One drawing per source, refusals included; a type that failed to load
  // is tried again at the next rendering. Each placeholder gets its own
  // copy: one source may be drawn in two places.
  const draw = (
    engine: DiagramModule,
    placeholder: Element,
    source: string,
  ) => {
    let drawn = diagrams.get(source);
    if (!drawn) {
      count("diagram.render");
      const entry = engine
        .render(source, diagramOptions(placeholder))
        .then(({ svg }) => checkedDiagram(svg, document));
      entry.catch((error: unknown) => {
        if (!refusal(engine, error) && diagrams.get(source) === entry) {
          diagrams.delete(source);
          console.warn("Pele", error);
        }
      });
      diagrams.set(source, entry);
      drawn = entry;
    }
    return drawn.then((diagram) => diagram.cloneNode(true) as Element);
  };

  const fillDiagrams = async (current: number) => {
    const placeholders = content.querySelectorAll<HTMLElement>(
      ".mermaid:not([data-drawn])",
    );
    if (placeholders.length === 0) return;
    pele ??= load.diagrams();
    let engine: DiagramModule;
    try {
      engine = await pele;
    } catch (error) {
      pele = undefined; // tried again at the next rendering
      console.warn("Pele", error);
      return;
    }
    for (const placeholder of Array.from(placeholders)) {
      if (current !== generation) return;
      const source = placeholder.dataset.source ?? "";
      try {
        const diagram = await draw(engine, placeholder, source);
        if (current !== generation) return;
        placeholder.replaceChildren(diagram);
        placeholder.dataset.drawn = "";
      } catch (error) {
        if (current !== generation) return;
        // A type that failed to load: its source stays, drawn next time.
        if (!refusal(engine, error)) continue;
        showError(placeholder, error);
        placeholder.dataset.drawn = "";
      }
    }
  };

  const render = () => {
    cancel();
    count("preview.render");
    const current = ++generation;
    const sources: string[] = [];
    waiting = [];
    const granted: GrantedImage = (src, lines) => {
      if (!sources.includes(src)) sources.push(src);
      if (!images?.granted(src)) return false;
      if (shownSources.has(src) || !caretIn(lines)) return true;
      waiting.push(lines);
      return false;
    };
    span("preview.render", () => {
      const { html, lines } = renderMarkdownBlocks(text(), granted);
      reconcile(content, html, origins);
      // Out of the HTML, which matches the kept blocks.
      const blocks = Array.from(content.children).filter(
        (element) => !element.matches("section.footnotes, hr.footnotes-sep"),
      ) as HTMLElement[];
      blocks.forEach((block, i) => {
        const [start, end] = lines[i] ?? [0, 0];
        block.dataset.line = String(start);
        block.dataset.lineEnd = String(end);
      });
    });
    forgetAbsent(content);
    // What the text can't say of a `[[…]]` to a note.
    for (const local of Array.from(
      content.querySelectorAll(".md-wikilink-local"),
    )) {
      local.setAttribute("title", t().wikilinkLocal);
    }
    fillImages();
    fillAttachedImages();
    tellImages(sources);
    for (const listener of rendered) listener();
    filling = Promise.all([fillFormulas(current), fillDiagrams(current)]).then(
      () => {},
    );
  };

  return {
    get visible() {
      return visible;
    },
    root: content,
    onAnchor(listener) {
      anchors.push(listener);
    },
    onRendered(listener) {
      rendered.push(listener);
    },
    onImages(listener) {
      imageListeners.push(listener);
    },
    changed() {
      if (!visible && imageListeners.length === 0) return;
      cancel();
      timer = setTimeout(visible ? render : scan, RENDER_DELAY_MS);
    },
    cursorsMoved() {
      if (!visible || timer !== undefined) return;
      if (waiting.some((lines) => !caretIn(lines))) render();
    },
    show() {
      visible = true;
      content.hidden = false;
      render();
    },
    hide() {
      visible = false;
      content.hidden = true;
      generation++;
      cancel();
    },
    async settled() {
      let awaited: Promise<void>;
      do {
        awaited = filling;
        await awaited;
      } while (awaited !== filling);
    },
  };
}
