// The hostile grammar the renderers' properties draw from (ADR-0021 §3,
// ADR-0047 §8): shared by the preview's and the annotations' properties.
import type { TestCase } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";

// Pieces of Markdown an author could write to reach a reader's page:
// raw HTML, URL schemes in every spelling and position, and each extension.
export const SCHEMES = [
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  " javascript:alert(1)",
  "java\tscript:alert(1)",
  "&#106;avascript:alert(1)",
  "&#x6A;avascript:alert(1)",
  "javascript&colon;alert(1)",
  "%6Aavascript:alert(1)",
  "vbscript:x",
  "file:///etc/passwd",
  "data:text/html,<script>alert(1)</script>",
  "data:image/svg+xml;base64,PHN2Zz4=",
  "data:image/png;base64,iVBO",
  "attachment:AAECAwQFBgcICQoLDA0ODw",
  "attachment:AAECAwQFBgcICQoLDA0ODB",
  "attachment:../AAECAwQFBgcICQoLDA",
  'attachment:AAECAwQFBgcICQoLDA0ODw" onerror="alert(1)',
  "ATTACHMENT:AAECAwQFBgcICQoLDA0ODw",
  "https://e.org/a?b=c&d#e",
  "https://e.org/p.png",
  "HTTPS://E.org/p.png",
  "https://e.org",
  "https://e.org?p",
  "http://e.org/p.png",
  "https://localhost/p.png",
  "https://a.local/p.png",
  "https://127.0.0.1/p.png",
  "https://0x7f.1/p.png",
  "https://[::1]/p.png",
  "https://intranet/p.png",
  "https://u:p@e.org/p.png",
  "https://e.org\\p.png",
  'https://e.org/p.png" onerror="alert(1)',
  "mailto:a@e.org",
  "#fn-md-1",
  "#title",
  "rel/path.png",
  "other.md",
  "/path",
  "?q=1",
  "//host.example/x",
  '"onmouseover="alert(1)',
];
export const RAW_HTML = [
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  '<a href="javascript:alert(1)">x</a>',
  "<iframe src=x></iframe>",
  "<style>*{}</style>",
  "<svg onload=alert(1)>",
  "<!-- c -->",
  "<b onmouseover=alert(1)>b</b>",
  "&lt;script&gt;",
];

function fragment(tc: TestCase): string {
  const url = () => tc.draw(gs.sampledFrom(SCHEMES));
  const text = () =>
    tc.draw(
      gs.sampledFrom([
        "x",
        "*e*",
        "`c`",
        "$t$",
        "[^n]",
        "\\",
        "]",
        ")",
        ">",
        '"',
      ]),
    );
  switch (tc.draw(gs.integers({ minValue: 0, maxValue: 20 }))) {
    case 0:
      return tc.draw(gs.sampledFrom(RAW_HTML));
    case 1:
      return `[${text()}](${url()})`;
    case 2:
      return `[${text()}](<${url()}> "t${text()}")`;
    case 3:
      return `![${text()}](${url()})`;
    case 4:
      return `<${url()}>`;
    case 5:
      return `[r]\n\n[r]: ${url()}\n`;
    case 6:
      return `![r]\n\n[r]: <${url()}>\n`;
    case 19:
      return `[${text()}][r]\n\n[r]: ${url()} "t${text()}"\n`;
    case 7:
      return `$${tc.draw(gs.sampledFrom(["\\href{javascript:alert(1)}{x}", "a<b", '"><img src=x onerror=alert(1)>', "x"]))}$`;
    case 8:
      return `\n$$\n${tc.draw(gs.sampledFrom(["</div><script>", "\\url{javascript:x}", "y"]))}\n$$\n`;
    case 9:
      return `\n\`\`\`${tc.draw(gs.sampledFrom(["mermaid", 'mermaid" onmouseover="x', 'js"><script>', ""]))}\n${tc.draw(gs.sampledFrom(RAW_HTML))}\n\`\`\`\n`;
    case 10:
      return `\n| a | ${text()} |\n|---|:-:|\n| ${text()} | ${url()} |\n`;
    case 11:
      return `[^n]\n\n[^n]: ${text()} ${tc.draw(gs.sampledFrom(RAW_HTML))}\n`;
    case 12:
      return `\n- [${tc.draw(gs.sampledFrom([" ", "x", "<"]))}] `;
    case 13:
      return tc.draw(
        gs.sampledFrom(["\n> ", "\n  - ", "\n1. ", "\n\n", "\n    ", "\n# "]),
      );
    case 14:
      return tc.draw(
        gs.sampledFrom(["~~", "**", "_", "|", "&amp;", "&#0;", "\u0000"]),
      );
    case 15:
      return url();
    case 16:
      return text();
    case 18:
      // Obsidian's [[…]] (phase 19): what an author puts in its target
      // and alias ends in a text or an anchor, never in an attribute.
      return `${tc.draw(gs.sampledFrom(["", "!"]))}[[${tc.draw(gs.sampledFrom(["#", "#^", ""]))}${tc.draw(gs.sampledFrom(['"onmouseover="x', "<img src=x>", "javascript:alert(1)", "a#b", "&amp;", "%"]))}${tc.draw(gs.sampledFrom(["", "|<b>", '|"x', "|"]))}]]`;
    case 17:
      return `\n> [!${tc.draw(gs.sampledFrom(['"onmouseover="x', "<b>", "a b|c", "x&amp;", "note"]))}]${tc.draw(gs.sampledFrom(["", "-", "+"]))} ${text()}\n> `;
    default:
      return tc.draw(gs.text({ maxSize: 8 }));
  }
}

/** A source of 1 to 12 fragments, run together, by a space or a line. */
export function hostileMarkdown(tc: TestCase): string {
  const count = tc.draw(gs.integers({ minValue: 1, maxValue: 12 }));
  return Array.from({ length: count }, () => fragment(tc)).join(
    tc.draw(gs.sampledFrom(["", " ", "\n"])),
  );
}
