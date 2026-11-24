import { t } from "../../i18n/index.js";

/** The journal of the annotations (ADR-0052 §5): a Markdown file of its
 * own, every annotation once, open or closed, in the order given (their
 * creation's, JA1). Pure: what each card shows in, Markdown out. Not
 * meant for an import: it would be text. */

export interface JournalEntry {
  /** The name shown (ADR-0040). */
  author: string;
  /** « commented », « suggests deleting »… */
  verb: string;
  /** Its date, written out. */
  when: string;
  /** « open », « resolved, by … »… */
  state: string;
  /** The text it covers or covered (TA1, TA2), or none to say (TA5);
   * absent for an addition, which covers none. */
  annotated?: { text: string; how?: string } | "unavailable";
  /** A suggestion's text, when its change is valid. */
  proposal?: string;
  body?: string;
  note?: string;
  replies: readonly { author: string; when: string; body: string }[];
}

/** A text on one line, in a heading or a list: its line breaks spaces,
 * what Markdown reads escaped — a list's marker too, at its head, where
 * it would open a list in a list item. */
function inline(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\`*_[\]<>#|~=$&]/g, "\\$&")
    .replace(/^(\d+)([.)])/, "$1\\$2")
    .replace(/^[-+]/, "\\$&");
}

/** Someone's text, kept in its entry (JA3): every line quoted, a heading
 * or a list it holds staying in the quote. */
function quote(text: string, indent = ""): string {
  return text
    .split("\n")
    .map((line) => `${indent}>${line === "" ? "" : ` ${line}`}`)
    .join("\n");
}

export function journalMarkdown(
  title: string,
  entries: readonly JournalEntry[],
): string {
  const colon = t().colon;
  const blocks = [`# ${inline(t().journalTitle(title))}`];
  if (entries.length === 0) blocks.push(t().journalNone);
  entries.forEach((entry, i) => {
    blocks.push(`## ${i + 1}. ${inline(`${entry.author} ${entry.verb}`)}`);
    blocks.push(
      [
        `- ${t().journalDate}${colon} ${inline(entry.when)}`,
        `- ${t().journalState}${colon} ${inline(entry.state)}`,
      ].join("\n"),
    );
    const said = (label: string, text: string | undefined) => {
      if (text === undefined) return;
      blocks.push(`${inline(label)}${colon}`, quote(text));
    };
    if (entry.annotated === "unavailable") {
      blocks.push(
        `${t().journalAnnotated}${colon} ${inline(t().journalUnavailable)}`,
      );
    } else if (entry.annotated) {
      const how = entry.annotated.how;
      said(
        how ? `${t().journalAnnotated}, ${how}` : t().journalAnnotated,
        entry.annotated.text,
      );
    }
    said(t().journalProposed, entry.proposal);
    said(t().journalComment, entry.body);
    said(t().journalNote, entry.note);
    if (entry.replies.length > 0) {
      blocks.push(`${t().journalReplies}${colon}`);
      blocks.push(
        entry.replies
          .map(
            (reply) =>
              `- ${inline(`${reply.author}, ${reply.when}`)}${colon}\n\n${quote(reply.body, "  ")}`,
          )
          .join("\n\n"),
      );
    }
  });
  return `${blocks.join("\n\n")}\n`;
}
