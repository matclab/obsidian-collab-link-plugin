// The only way HTML goes into an element, in the page and the plugin: HTML
// one of the renderers named here made, typed so that nothing else reaches
// `setRenderedHtml` (`trusted-html.test.ts`). Obsidian's directory refuses
// a plugin's `innerHTML`; this one is shown to its reviewers with its
// reason (docs/phase-41-lint-de-l-annuaire-obsidian.md).

declare const rendered: unique symbol;

/** HTML a renderer named in this module made, never a text as such. */
export type RenderedHtml = string & { readonly [rendered]: true };

/** markdown-it's rendering (`render.ts`): `html: false`, so any HTML of
 * the text comes out escaped, and its links checked (ADR-0021). */
export const markdownItHtml = (html: string): RenderedHtml =>
  html as RenderedHtml;

/** KaTeX's rendering of a formula, `trust: false`: no `\href`, `\url`,
 * `\html…` (ADR-0021 §3). */
export const katexHtml = (html: string): RenderedHtml => html as RenderedHtml;

/** One of the page's own drawings (`callout-icons.ts`), never a
 * document's. */
export const ownDrawing = (svg: string): RenderedHtml => svg as RenderedHtml;

/** A diagram's drawing, Pele's (`links: false`, `images: false`), parsed
 * by `checkedDiagram` into an inert template only, and shown once checked
 * against what Pele draws (ADR-0042). */
export const peleSvg = (svg: string): RenderedHtml => svg as RenderedHtml;

/** `html` as `element`'s content; a template's stays inert. */
export function setRenderedHtml(element: Element, html: RenderedHtml): void {
  // eslint-disable-next-line no-unsanitized/property -- RenderedHtml only, made by the renderers this module names: markdown-it without HTML, KaTeX without trust, the page's own drawings, Pele's SVG checked before it is shown
  element.innerHTML = html;
}
