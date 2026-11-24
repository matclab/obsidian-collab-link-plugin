// What Obsidian asks of the plugin's view as it shows a note, and the
// heading it names (docs/phase-16-plan-du-document.md, decisions 8, 9):
// its outline gives a line of the file, a link a subpath; both are found
// in Obsidian's metadataCache, whose heading is named for the view by its
// raw text, level and occurrence — the file is the export, a little late,
// with its header's lines.
import type { HeadingCache } from "obsidian";
import type { HeadingTarget } from "../../web/src/embed.js";

/** What the view takes of an ephemeral state: the focus, a line of the
 * file, a heading's subpath. Nothing else (a block, a search match). */
export interface EphemeralRequest {
  focus: boolean;
  line?: number;
  subpath?: string;
}

export function ephemeralRequest(state: unknown): EphemeralRequest | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  const { focus, line, subpath } = state as Record<string, unknown>;
  const request: EphemeralRequest = { focus: focus === true };
  if (typeof line === "number" && Number.isInteger(line) && line >= 0) {
    request.line = line;
  } else if (
    typeof subpath === "string" &&
    subpath.startsWith("#") &&
    !subpath.startsWith("#^") &&
    subpath.length > 1
  ) {
    request.subpath = subpath;
  }
  if (!request.focus && request.line === undefined && !request.subpath) {
    return undefined;
  }
  return request;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The heading `request` names: the one at its line, or whose section the
 * line is in; or the one its subpath resolves to (`resolve`: Obsidian's
 * `resolveSubpath`). */
export function targetFor(
  headings: readonly HeadingCache[] | undefined,
  request: Pick<EphemeralRequest, "line" | "subpath">,
  resolve: (subpath: string) => HeadingCache | undefined,
): HeadingTarget | undefined {
  if (!headings) return undefined;
  let found: HeadingCache | undefined;
  if (request.line !== undefined) {
    for (const heading of headings) {
      if (heading.position.start.line > request.line) break;
      found = heading;
    }
  } else if (request.subpath) {
    found = resolve(request.subpath);
  }
  if (!found) return undefined;
  // By its line: `resolveSubpath` may give a copy of the cache's entry.
  const line = found.position.start.line;
  const at = headings.findIndex((h) => h.position.start.line === line);
  if (at < 0) return undefined;
  const source = oneLine(found.heading);
  let occurrence = 0;
  for (const other of headings.slice(0, at)) {
    if (other.level === found.level && oneLine(other.heading) === source) {
      occurrence++;
    }
  }
  return { source, level: found.level, occurrence };
}
