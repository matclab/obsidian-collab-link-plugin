// The index of the rule identifiers the code cites
// (docs/phase-12-refactorisation.md, decision 10): `R-B4`, `D-37`, `N4`…
// are defined in the phase plans, the ADRs, the specification and the
// security notes, each by a bullet that opens with it in bold. Written to
// docs/rules-index.md by `node scripts/rules-index.mjs` (in web/), checked
// by `rules-index.test.ts`. Node only, never in the page.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/** A rule identifier — letters, an optional dash, digits (`R-B4`, `N4`,
 * `SW5`, `D-37`) — not inside a longer one (`R-L1` is not `L1`). */
const ID = String.raw`([A-Z]{1,3}(?:-[A-Z])?-?\d+[a-z]?)`;
const NOT_INSIDE_BEFORE = String.raw`(?<![\w-])`;
const NOT_INSIDE_AFTER = String.raw`(?![\w-])`;

const DEFINITION = new RegExp(
  String.raw`^\s*[-*]\s+\*\*${ID}${NOT_INSIDE_AFTER}`,
);

export interface Definition {
  id: string;
  /** From the repository's root. */
  file: string;
  line: number;
  title: string;
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.name.endsWith(".md") ? [full] : [];
  });
}

/** Every definition in `docs/` and `prd.md`: identifier, document, line,
 * title — the rest of the bold run, or the start of the bullet. */
export function definitions(root: string): Definition[] {
  const files = [
    ...markdownFiles(path.join(root, "docs")),
    path.join(root, "prd.md"),
  ]
    .filter((file) => !file.endsWith("rules-index.md"))
    .sort();
  const found: Definition[] = [];
  for (const file of files) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        const id = DEFINITION.exec(line)?.[1];
        if (!id) return;
        const bold = /\*\*([^*]*)\*\*/.exec(line)?.[1] ?? "";
        let title = bold
          .slice(id.length)
          .replace(/^[\s.:—-]+|[\s.:]+$/g, "")
          .replace(/^\((.*)\)$/, "$1");
        if (!title) {
          const rest = line.slice(line.indexOf("**", line.indexOf(id)) + 2);
          title = rest
            .replace(/^[\s.:—-]+/, "")
            .slice(0, 80)
            .trim();
        }
        found.push({
          id,
          file: path.relative(root, file),
          line: index + 1,
          title: title.replace(/\|/g, "\\|"),
        });
      });
  }
  return found;
}

/** Identifiers two documents define, by the documents that do. One the
 * specification defines (`docs/protocol/`) is the specification's: a phase
 * plan is history. */
export function ambiguous(defs: Definition[]): Map<string, string[]> {
  const byId = new Map<string, Set<string>>();
  for (const def of defs) {
    byId.set(def.id, (byId.get(def.id) ?? new Set()).add(def.file));
  }
  const result = new Map<string, string[]>();
  for (const [id, files] of byId) {
    if (files.size < 2) continue;
    if ([...files].some((file) => file.startsWith("docs/protocol/"))) continue;
    result.set(id, [...files].sort());
  }
  return result;
}

/** What names `file` in a comment: `phase 9`, `phase-9-durcissement`,
 * `threat model`, or the document's name. */
function qualifier(file: string): RegExp {
  const base = path.basename(file, ".md");
  const phase = /^phase-(\d+[a-z]*)/.exec(base)?.[1];
  if (phase) return new RegExp(String.raw`phase[ -]${phase}(?![\w])`, "i");
  if (base === "threat-model") return /threat[ -]model/i;
  return new RegExp(base.replace(/-/g, "[ -]"), "i");
}

export interface Citation {
  file: string;
  line: number;
  id: string;
  text: string;
}

/** Citations of an ambiguous identifier that name none of its documents,
 * on their line or the two before (a comment wraps). */
export function unqualified(
  sources: { file: string; text: string }[],
  amb: Map<string, string[]>,
): Citation[] {
  const cite = new RegExp(`${NOT_INSIDE_BEFORE}${ID}${NOT_INSIDE_AFTER}`, "g");
  const found: Citation[] = [];
  for (const { file, text } of sources) {
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      for (const match of line.matchAll(cite)) {
        const id = match[1] ?? "";
        const docs = amb.get(id);
        if (!docs) continue;
        const context = lines
          .slice(Math.max(0, index - 2), index + 1)
          .join(" ");
        if (docs.some((doc) => qualifier(doc).test(context))) continue;
        found.push({ file, line: index + 1, id, text: line.trim() });
      }
    });
  }
  return found;
}

export function render(defs: Definition[]): string {
  const amb = ambiguous(defs);
  const rows = [...defs].sort(
    (a, b) =>
      a.id.localeCompare(b.id, "en", { numeric: true }) ||
      a.file.localeCompare(b.file),
  );
  return [
    "# Index des identifiants de règles",
    "",
    "Écrit par `web/scripts/rules-index.mjs` (`node scripts/rules-index.mjs` dans `web/`), vérifié par `web/src/docs/rules-index.test.ts` : ne pas l'éditer à la main. Une règle se définit par une puce qui commence par son identifiant en gras (`- **R-B1 (…)**`).",
    "",
    "Un identifiant défini dans deux documents avec deux sens (marqué ⚠) se cite avec son document (`phase 9, L4`, `threat model P5`) ; un identifiant de la spécification (`docs/protocol/`) est toujours celui de la spécification.",
    "",
    "| Identifiant | Document | Ligne | Titre |",
    "|---|---|---|---|",
    ...rows.map(
      (def) =>
        `| ${def.id}${amb.has(def.id) ? " ⚠" : ""} | \`${def.file}\` | ${def.line} | ${def.title} |`,
    ),
    "",
  ].join("\n");
}
