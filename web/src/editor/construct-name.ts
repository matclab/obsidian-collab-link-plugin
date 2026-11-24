import { en } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import {
  type CalloutFamily,
  calloutWords,
  defaultCalloutTitle,
} from "../render/index.js";
import type { ConstructId } from "./constructs.js";

/** Each construction's name in the dictionary: one text each,
 * as every other. */
const KEYS = {
  bold: "constructBold",
  italic: "constructItalic",
  strikethrough: "constructStrikethrough",
  highlight: "constructHighlight",
  code: "constructCode",
  link: "constructLink",
  paragraph: "constructParagraph",
  heading1: "constructHeading1",
  heading2: "constructHeading2",
  heading3: "constructHeading3",
  heading4: "constructHeading4",
  heading5: "constructHeading5",
  heading6: "constructHeading6",
  bulletList: "constructBulletList",
  orderedList: "constructOrderedList",
  taskList: "constructTaskList",
  quote: "constructQuote",
  callout: "constructCallout",
  table: "constructTable",
  codeBlock: "constructCodeBlock",
  mathBlock: "constructMathBlock",
  diagram: "constructDiagram",
  rule: "constructRule",
  footnote: "constructFootnote",
  image: "constructImage",
} as const satisfies Record<ConstructId, string>;

export function constructName(id: ConstructId): string {
  return t()[KEYS[id]];
}

/** What the / menu filters on: the name in the page's language, in
 * English, and a few usual spellings. */
const ALIASES: Partial<Record<ConstructId, readonly string[]>> = {
  heading1: ["h1"],
  heading2: ["h2"],
  heading3: ["h3"],
  heading4: ["h4"],
  heading5: ["h5"],
  heading6: ["h6"],
  bulletList: ["ul"],
  orderedList: ["ol"],
  taskList: ["todo"],
  mathBlock: ["latex", "math"],
  diagram: ["mermaid"],
  rule: ["hr"],
  image: ["img", "picture", "photo"],
};

export function constructNames(id: ConstructId): readonly string[] {
  return [t()[KEYS[id]], en[KEYS[id]], ...(ALIASES[id] ?? [])];
}

/** Each callout family's name in the dictionary (ADR-0063, EN1). */
const FAMILY_KEYS = {
  note: "calloutNote",
  abstract: "calloutAbstract",
  info: "calloutInfo",
  todo: "calloutTodo",
  tip: "calloutTip",
  success: "calloutSuccess",
  question: "calloutQuestion",
  warning: "calloutWarning",
  failure: "calloutFailure",
  danger: "calloutDanger",
  bug: "calloutBug",
  example: "calloutExample",
  quote: "calloutQuote",
} as const satisfies Record<CalloutFamily, string>;

export function calloutName(family: CalloutFamily): string {
  return t()[FAMILY_KEYS[family]];
}

/** What the / menu filters a family on (EN2): its name in the page's
 * language, in English, and the words Obsidian reads as it. */
export function calloutNames(family: CalloutFamily): readonly string[] {
  return [
    calloutName(family),
    en[FAMILY_KEYS[family]],
    ...calloutWords(family),
  ];
}

/** The title a family's callout is inserted with (EN3): its name, none
 * when that is the title Obsidian gives it anyway. */
export function calloutTitle(family: CalloutFamily): string {
  const name = calloutName(family);
  return name === defaultCalloutTitle(family) ? "" : name;
}
