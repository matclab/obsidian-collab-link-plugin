import { count } from "../../perf/index.js";
import { renderAnnotationText } from "../../render/index.js";

/** What of a card holds a text to render. */
interface CardTexts {
  body: string | undefined;
  note: string | undefined;
  replies: readonly { body: string }[];
}

/** The cards' texts as HTML (ADR-0047 §9), shared by the panel's cards: a
 * text is rendered once while a card shows it — not again when its card is
 * drawn anew (a status, a reply, a move to the closed ones). */
export class AnnotationTexts {
  #html = new Map<string, string>();

  /** The HTML of `text`, its last line break dropped. */
  html(text: string): string {
    let html = this.#html.get(text);
    if (html === undefined) {
      count("annotation.text.render");
      html = renderAnnotationText(text).trimEnd();
      this.#html.set(text, html);
    }
    return html;
  }

  /** Forgets the texts none of `cards` shows, before they are drawn. */
  keep(cards: readonly CardTexts[]): void {
    const shown = new Set<string>();
    for (const card of cards) {
      if (card.body) shown.add(card.body);
      if (card.note) shown.add(card.note);
      for (const reply of card.replies) shown.add(reply.body);
    }
    for (const text of this.#html.keys()) {
      if (!shown.has(text)) this.#html.delete(text);
    }
  }

  get size(): number {
    return this.#html.size;
  }
}
