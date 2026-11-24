import type { RenderOptions } from "pele";
import { peleSvg, setRenderedHtml } from "../../render/index.js";

/** What every diagram is drawn with, whatever its source says (ADR-0042,
 * decisions 3 and 5): no link, no image (a request would tell a third
 * party when and where the document is read, ADR-0021 §5), one layout
 * whatever the width. A `%%{init}%%` directive reaches `config` only. */
export const DIAGRAM_OPTIONS = {
  links: false,
  images: false,
  autoDirection: false,
} as const satisfies RenderOptions;

const SVG = "http://www.w3.org/2000/svg";

/** Every element Pele draws with, links and images off (its corpus, all
 * diagram types). */
const ELEMENTS = new Set([
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "title",
  "desc",
]);

/** Attributes that only carry text (the author's, in `data-id`): never
 * read as a URL. */
const TEXT_ONLY = /^(data-|aria-)|^(class|id|role)$/;

/** The CSS functions a value may call: none of them loads anything
 * (`url(`, `image-set(`, `image(`… would; so would an escaped name,
 * `u\72l(`, which is none of these). */
const FUNCTIONS = new Set([
  "var",
  "calc",
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "color-mix",
  "translate",
  "rotate",
  "scale",
  "matrix",
  "skewx",
  "skewy",
]);

function refused(attribute: Attr): boolean {
  const name = attribute.localName.toLowerCase();
  if (name.startsWith("on") || name.endsWith("href")) return true;
  if (TEXT_ONLY.test(name)) return false;
  const value = attribute.value.toLowerCase();
  return Array.from(value.matchAll(/([^\s(),:;]*)\s*\(/g)).some(
    ([, called]) => !FUNCTIONS.has(called ?? ""),
  );
}

/** A drawing the check refuses: shown as an error, like a source Pele
 * cannot draw. */
export class DiagramRefused extends Error {}

/** The diagram as an element, once checked against what Pele draws: the
 * check that replaces Mermaid's sandbox (ADR-0042, decision 4). Throws on
 * anything else — a refusal, never a cleaning. */
export function checkedDiagram(markup: string, document: Document): Element {
  const template = document.createElement("template");
  setRenderedHtml(template, peleSvg(markup));
  const nodes = Array.from(template.content.childNodes);
  const root = template.content.firstElementChild;
  if (
    !root ||
    root.localName !== "svg" ||
    nodes.some(
      (node) =>
        node !== root &&
        !(node.nodeType === node.TEXT_NODE && !node.textContent?.trim()),
    )
  ) {
    throw new DiagramRefused("not a diagram");
  }
  for (const element of [root, ...Array.from(root.querySelectorAll("*"))]) {
    if (element.namespaceURI !== SVG || !ELEMENTS.has(element.localName)) {
      throw new DiagramRefused(`a diagram may not hold <${element.localName}>`);
    }
    const attribute = Array.from(element.attributes).find(refused);
    if (attribute) {
      throw new DiagramRefused(`a diagram may not hold ${attribute.name}="…"`);
    }
  }
  return root;
}
