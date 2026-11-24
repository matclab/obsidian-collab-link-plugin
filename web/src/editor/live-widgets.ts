import { Facet } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { WidgetType } from "@codemirror/view";
import { t } from "../i18n/index.js";
import { count } from "../perf/index.js";
import { type CalloutFamily, calloutIcon } from "../render/index.js";
import type {
  AttachedImages,
  AttachedState,
} from "../view-model/attached-images.js";
import {
  KATEX_OPTIONS,
  type KatexModule,
  loadKatex,
} from "../view-model/katex.js";

/** Where the editor's formulas get KaTeX: the page's loader (ADR-0021 §6),
 * or a test's. */
export const katexLoader = Facet.define<
  () => Promise<KatexModule>,
  () => Promise<KatexModule>
>({ combine: (loaders) => loaders[0] ?? loadKatex });

/** Formulas drawn, by mode and TeX: a widget drawn again (scrolled back,
 * its line left) costs no KaTeX. Bounded: the oldest go first. */
const drawn = new Map<string, string>();
const DRAWN_MAX = 500;

/** Draws a formula into `element`: its source until KaTeX is
 * loaded, then its rendering, with the preview's options (ADR-0021 §3).
 * What finishes after the load writes only into an element still in the
 * editor. */
export function drawFormula(
  view: EditorView,
  element: HTMLElement,
  tex: string,
  display: boolean,
): void {
  // Its source, on it: what it must show is checked against it.
  element.dataset.tex = tex;
  const key = `${display ? "D" : "I"}${tex}`;
  const html = drawn.get(key);
  if (html !== undefined) {
    element.innerHTML = html;
    return;
  }
  element.textContent = tex;
  view.state
    .facet(katexLoader)()
    .then((katex) => {
      if (!element.isConnected) return;
      let rendered = drawn.get(key);
      if (rendered === undefined) {
        count("katex.render");
        rendered = katex.renderToString(tex, {
          ...KATEX_OPTIONS,
          displayMode: display,
        });
        drawn.set(key, rendered);
        if (drawn.size > DRAWN_MAX) {
          const oldest = drawn.keys().next().value;
          if (oldest !== undefined) drawn.delete(oldest);
        }
      }
      element.innerHTML = rendered;
    })
    .catch((error: unknown) => {
      // The source stays; tried again when the widget is drawn again.
      console.warn("KaTeX", error);
    });
}

/** A formula, in a line or as a block of its own (a `$$` block). A click on it
 * places the caret there, which shows its source. */
export class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
    readonly block = false,
  ) {
    super();
  }
  override eq(other: MathWidget): boolean {
    return (
      other.tex === this.tex &&
      other.display === this.display &&
      other.block === this.block
    );
  }
  override get estimatedHeight(): number {
    return this.display ? 48 : -1;
  }
  override toDOM(view: EditorView): HTMLElement {
    const element = document.createElement(this.block ? "div" : "span");
    element.className = this.display
      ? "cm-live-math cm-live-math-display"
      : "cm-live-math";
    drawFormula(view, element, this.tex, this.display);
    return element;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

/** An embedded raster image (ADR-0021 §5: never a remote one). */
export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    /** A remote image (ADR-0055 §8, §13): told if it fails to load. */
    readonly failed?: (src: string) => void,
  ) {
    super();
  }
  override eq(other: ImageWidget): boolean {
    return (
      other.src === this.src &&
      other.alt === this.alt &&
      !other.failed === !this.failed
    );
  }
  override toDOM(): HTMLElement {
    const image = document.createElement("img");
    image.className = "cm-live-image";
    image.alt = this.alt;
    if (!this.failed) {
      image.src = this.src;
      return image;
    }
    // Before its address: the request carries no referrer (§8).
    image.setAttribute("referrerpolicy", "no-referrer");
    const { failed, src } = this;
    image.addEventListener("error", () => failed(src));
    image.src = src;
    const box = document.createElement("span");
    box.className = "cm-live-remote-image";
    const from = document.createElement("span");
    from.className = "remote-image-from";
    from.textContent = t().remoteImageFrom(new URL(src).hostname);
    box.append(image, from);
    return box;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

/** The document's attached images (ADR-0057 §8), for the editor's
 * widgets: the view's; none, each stays its text. */
export const attachedImagesFacet = Facet.define<
  AttachedImages,
  AttachedImages | undefined
>({ combine: (values) => values[0] });

/** What a slot shows of an image not drawn: its text and why. */
function attachedNote(state: AttachedState): string {
  switch (state.kind) {
    case "loading":
      return t().attachedImageLoading;
    case "absent":
      return t().attachedImageAbsent;
    case "unreadable":
      return t().attachedImageUnreadable;
    default:
      return t().attachedImageUnavailable;
  }
}

/** An image attached to the document (ADR-0057 §8): drawn once its view
 * has it, in place, as it arrives — never the decorations again. */
export class AttachedImageWidget extends WidgetType {
  private stop: (() => void) | undefined;
  constructor(
    readonly id: string,
    readonly alt: string,
    readonly images: AttachedImages | undefined,
  ) {
    super();
  }
  override eq(other: AttachedImageWidget): boolean {
    return (
      other.id === this.id &&
      other.alt === this.alt &&
      other.images === this.images
    );
  }
  override toDOM(): HTMLElement {
    const box = document.createElement("span");
    box.className = "cm-live-attached-image";
    const { images } = this;
    const draw = () => {
      const state = images?.state(this.id) ?? { kind: "absent" as const };
      if (state.kind === "shown") {
        const image = document.createElement("img");
        image.className = "cm-live-image";
        image.alt = this.alt;
        image.src = state.url;
        box.replaceChildren(image);
        return true;
      }
      const text = document.createElement("span");
      text.className = "attached-image-text";
      text.textContent = this.alt;
      const note = document.createElement("span");
      note.className = "attached-image-note";
      note.textContent = attachedNote(state);
      box.replaceChildren(text, note);
      return state.kind !== "loading";
    };
    if (!draw() && images) {
      this.stop?.();
      const stop = images.subscribe((ids) => {
        if (ids.includes(this.id) && draw()) stop();
      });
      this.stop = stop;
    }
    return box;
  }
  override destroy(): void {
    this.stop?.();
    this.stop = undefined;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

/** A remote image not granted (ADR-0055 §3, §6): its domain and a button
 * that grants it, after its text. Its events are its own: a click doesn't
 * move the caret onto its line, which would show the source instead. */
export class ImageCaseWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly grant: (src: string) => void,
  ) {
    super();
  }
  override eq(other: ImageCaseWidget): boolean {
    return other.src === this.src;
  }
  override toDOM(): HTMLElement {
    const box = document.createElement("span");
    box.className = "cm-live-remote-image-case";
    const hostName = new URL(this.src).hostname;
    const host = document.createElement("span");
    host.className = "remote-image-host";
    host.textContent = hostName;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "quiet remote-image-grant";
    button.textContent = t().remoteImageShow;
    button.setAttribute("aria-label", t().remoteImageShowLabel(hostName));
    const { grant, src } = this;
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => grant(src));
    box.append(host, button);
    return box;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

/** A list's bullet, shown as a dot. */
export class BulletWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }
  override toDOM(): HTMLElement {
    const dot = document.createElement("span");
    dot.className = "cm-live-bullet";
    dot.textContent = "•";
    return dot;
  }
}

/** A callout's header, in place of its markup: its family's icon, decorative,
 * then its default title when it has
 * none — text of the document, not of the page, never translated. */
export class CalloutHeaderWidget extends WidgetType {
  constructor(
    readonly family: CalloutFamily,
    readonly title: string,
  ) {
    super();
  }
  override eq(other: CalloutHeaderWidget): boolean {
    return other.family === this.family && other.title === this.title;
  }
  override toDOM(): HTMLElement {
    const header = document.createElement("span");
    header.className = "cm-live-callout-header";
    const icon = document.createElement("span");
    icon.className = "cm-live-callout-icon";
    // A fixed drawing (`render/callout-icons.ts`), never the document's.
    icon.innerHTML = calloutIcon(this.family);
    header.append(icon);
    if (this.title) {
      const title = document.createElement("span");
      title.className = "cm-live-callout-default";
      title.textContent = this.title;
      header.append(title);
    }
    return header;
  }
}

/** A task's box: an editor ticks it with a click,
 * an edit of `[ ]` into `[x]` like any other, undoable; for a link that may
 * not write, it is read only. It takes its events from the editor: a click
 * would otherwise place the caret on its line, which shows the source and
 * takes the box away before the click ends. */
export class TaskWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  override eq(other: TaskWidget): boolean {
    return other.checked === this.checked;
  }
  override toDOM(view: EditorView): HTMLElement {
    // The item's marker, the width its text hangs from.
    const marker = document.createElement("span");
    marker.className = "cm-live-task-marker";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-live-task";
    box.checked = this.checked;
    // Not `disabled`: greyed out, an unticked box is almost unseen (in
    // Review); a click is refused below, by `toggleTask`.
    if (view.state.readOnly) box.setAttribute("aria-disabled", "true");
    box.setAttribute("aria-label", t().task);
    box.addEventListener("mousedown", (event) => event.preventDefault());
    box.addEventListener("click", (event) => {
      // The text decides: the box is drawn again from it.
      event.preventDefault();
      toggleTask(view, view.posAtDOM(marker));
    });
    marker.append(box);
    return marker;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

/** Ticks or unticks the task marker at `pos`; nothing when the editor may
 * not write, or `pos` is no longer a marker. */
export function toggleTask(view: EditorView, pos: number): boolean {
  if (view.state.readOnly) return false;
  const marker = view.state.doc.sliceString(pos, pos + 3);
  if (!/^\[[ xX]\]$/.test(marker)) return false;
  view.dispatch({
    changes: {
      from: pos + 1,
      to: pos + 2,
      insert: marker[1] === " " ? "x" : " ",
    },
    userEvent: "input",
  });
  return true;
}
