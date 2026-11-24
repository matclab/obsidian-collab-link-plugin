// @vitest-environment jsdom
import * as hegel from "@hegeldev/hegel";
import type { TestCase } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { PeleError, type RenderOptions, render } from "pele";
import { describe, test } from "vitest";
import { DIAGRAM_OPTIONS, checkedDiagram } from "./diagram.js";

// jsdom has no canvas: widths from the length, as Pele's own table would.
const OPTIONS: RenderOptions = {
  ...DIAGRAM_OPTIONS,
  measurer: { width: (text, size) => text.length * size * 0.6 },
};

// What an author could write in a diagram to reach a reader's page
// (ADR-0042): HTML in labels, links and images of every scheme, styles,
// directives, icons.
const URLS = [
  "https://e.org/x.png",
  "//e.org/x",
  "javascript:alert(1)",
  " JaVa\tScRiPt:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "data:image/png;base64,iVBO",
  "vbscript:x",
  "obsidian://open?x",
  "#a",
  "rel/x.png",
  '"><script>alert(1)</script>',
];
const LABELS = [
  "x",
  "<img src=https://e.org/x.png onerror=alert(1)>",
  "<script>alert(1)</script>",
  "<a href='javascript:alert(1)'>x</a>",
  "</text><foreignObject><div>x</div></foreignObject>",
  '"><svg onload=alert(1)>',
  "`**b** _i_`",
  "fa:fa-car x",
  "&lt;b&gt;&#106;",
  "a<br/>b",
];
const STYLES = [
  "fill:url(https://e.org/x)",
  "fill:#f00,stroke:url(#a)",
  "background-image:url(//e.org/y)",
  "fill:expression(alert(1))",
  "color:red;behavior:url(x.htc)",
];
const DIRECTIVES = [
  '%%{init: {"securityLevel": "loose", "flowchart": {"htmlLabels": true}}}%%',
  '%%{init: {"themeCSS": "* {background: url(https://e.org/x)}"}}%%',
  '%%{init: {"theme": "base", "themeVariables": {"primaryColor": "url(https://e.org/x)"}}}%%',
  "---\nconfig:\n  htmlLabels: true\n  securityLevel: loose\n---",
  '%%{init: {"links": true, "images": true}}%%',
];

type Body = (tc: TestCase, label: () => string, url: () => string) => string;

const KINDS: [string, Body][] = [
  [
    "flowchart LR\nA --> B",
    (tc, label, url) =>
      tc.draw(
        gs.sampledFrom([
          `A["${label()}"] --> B("${label()}")`,
          `A -->|"${label()}"| B`,
          `click A "${url()}" "${label()}"`,
          `click B href "${url()}" _blank`,
          "click A call alert(1)",
          `A@{ img: "${url()}", label: "${label()}" }`,
          `B@{ icon: "fa:car", form: "square", label: "${label()}" }`,
          `style A ${tc.draw(gs.sampledFrom(STYLES))}`,
          `classDef c ${tc.draw(gs.sampledFrom(STYLES))}\nclass B c`,
          `linkStyle 0 ${tc.draw(gs.sampledFrom(STYLES))}`,
          `subgraph S["${label()}"]\nC\nend`,
          `accTitle: ${label()}\naccDescr: ${label()}`,
        ]),
      ),
  ],
  [
    "sequenceDiagram\nAlice->>Bob: hi",
    (tc, label, url) =>
      tc.draw(
        gs.sampledFrom([
          `Alice->>Bob: ${label()}`,
          `link Alice: L @ ${url()}`,
          `links Bob: {"L": "${url()}"}`,
          `Note over Alice: ${label()}`,
          `participant A as ${label()}`,
        ]),
      ),
  ],
  [
    "classDiagram\nclass A\nA <|-- B",
    (tc, label, url) =>
      tc.draw(
        gs.sampledFrom([
          "class A{+int x}\nA <|-- B",
          `click A href "${url()}"`,
          `link A "${url()}" "${label()}"`,
          `note for A "${label()}"`,
          `style A ${tc.draw(gs.sampledFrom(STYLES))}`,
        ]),
      ),
  ],
  [
    "stateDiagram-v2\n[*] --> S",
    (tc, label) =>
      tc.draw(
        gs.sampledFrom([
          `[*] --> S: ${label()}`,
          `S: ${label()}`,
          `classDef c ${tc.draw(gs.sampledFrom(STYLES))}\nclass S c`,
        ]),
      ),
  ],
  [
    "gantt\ndateFormat YYYY-MM-DD\nsection S\nT :a1, 2026-01-01, 3d",
    (tc, label, url) =>
      tc.draw(
        gs.sampledFrom([
          `${label()} :a1, 2026-01-01, 3d`,
          `click a1 href "${url()}"`,
          "click a1 call alert(1)",
        ]),
      ),
  ],
  [
    'C4Context\nPerson(p, "P")',
    (tc, label, url) =>
      tc.draw(
        gs.sampledFrom([
          `Person(p, "${label()}", "${label()}", $link="${url()}")`,
          `System(s, "${label()}", $sprite="${url()}")`,
          `UpdateElementStyle(p, $bgColor="${tc.draw(gs.sampledFrom(STYLES))}")`,
        ]),
      ),
  ],
  [
    "architecture-beta",
    (tc, label, url) =>
      tc.draw(
        gs.sampledFrom([
          `service s(internet)[${label()}]`,
          `service t(${url()})[x]`,
          `group g(cloud)[${label()}]`,
        ]),
      ),
  ],
  [
    "mindmap\n  root",
    (tc, label) =>
      tc.draw(
        gs.sampledFrom([
          `    A[${label()}]`,
          "    ::icon(fa fa-book)",
          "    B",
        ]),
      ),
  ],
  ["pie", (_, label) => `"${label()}" : 1`],
  ["erDiagram", (_, label) => `A ||--o{ B : "${label()}"`],
  ["journey\nsection S", (_, label) => `${label()}: 5: Me`],
  [
    "kanban\n  todo[Todo]",
    (tc, label, url) =>
      tc.draw(
        gs.sampledFrom([
          `    t1[${label()}]`,
          `    t2[x]@{ ticket: 1, assigned: "${label()}" }`,
          `---\nconfig:\n  kanban:\n    ticketBaseUrl: '${url()}#TICKET#'\n---`,
        ]),
      ),
  ],
];

function source(tc: TestCase): string {
  const label = () => tc.draw(gs.sampledFrom(LABELS));
  const url = () => tc.draw(gs.sampledFrom(URLS));
  const [header, body] = tc.draw(gs.sampledFrom(KINDS));
  const lines = Array.from(
    { length: tc.draw(gs.integers({ minValue: 1, maxValue: 6 })) },
    () => body(tc, label, url),
  );
  const directive = tc.draw(gs.booleans())
    ? `${tc.draw(gs.sampledFrom(DIRECTIVES))}\n`
    : "";
  return `${directive}${header}\n${lines.join("\n")}\n`;
}

describe("diagrams (property, ADR-0042)", () => {
  test(
    "whatever its source, a diagram is refused by Pele or passes the check",
    () =>
      hegel.test(
        (tc) => {
          const text = source(tc);
          let svg: string;
          try {
            svg = render(text, OPTIONS).svg;
          } catch (error) {
            if (error instanceof PeleError) return;
            throw error;
          }
          try {
            checkedDiagram(svg, document);
          } catch (error) {
            throw new Error(
              `${(error as Error).message}\nsource=${JSON.stringify(text)}\nsvg=${svg}`,
            );
          }
        },
        { testCases: 400 },
      ),
    120_000,
  );

  test("no link and no image reaches the page, whatever their scheme", () =>
    hegel.test(
      (tc) => {
        const url = () => tc.draw(gs.sampledFrom(URLS));
        const lines = Array.from(
          { length: tc.draw(gs.integers({ minValue: 1, maxValue: 4 })) },
          () =>
            tc.draw(
              gs.sampledFrom([
                `click A "${url()}"`,
                `click B href "${url()}" _blank`,
                `A@{ img: "${url()}", label: "x" }`,
                `B@{ img: "${url()}", h: 40, constraint: "on" }`,
              ]),
            ),
        );
        const text = `flowchart LR\nA --> B\n${lines.join("\n")}\n`;
        let svg: string;
        try {
          svg = render(text, OPTIONS).svg;
        } catch (error) {
          if (error instanceof PeleError) return;
          throw error;
        }
        checkedDiagram(svg, document);
      },
      { testCases: 200 },
    ));

  test("arbitrary text: a PeleError or a diagram, never anything else", () =>
    hegel.test((tc) => {
      const [header] = tc.draw(gs.sampledFrom(KINDS));
      const text = `${header}\n${tc.draw(gs.text({ maxSize: 120 }))}`;
      try {
        checkedDiagram(render(text, OPTIONS).svg, document);
      } catch (error) {
        if (!(error instanceof PeleError)) throw error;
      }
    }));
});
