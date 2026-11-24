import type { LoroDoc, OpId, VersionVector } from "loro-crdt";
import type { Verdict } from "../../../lib/src/index.js";
import { authors, groupVersions, listVersions } from "../../history/index.js";
import { count } from "../../perf/index.js";

/** A line as `HistoryView.svelte` shows it. */
export interface HistoryRow {
  key: string;
  kind: "group" | "named";
  title: string;
  detail: string;
  current: boolean;
  available: boolean;
  /** Whether its name is signed (docs/protocol/06-identity.md): a named
   * version's, or, for a group, the name of every peer in it, by one key. */
  signature: Verdict;
  /** The name the signature covers. */
  signedName: string;
}

/** One line of the history view. */
export type HistoryEntry =
  | {
      kind: "group";
      key: string;
      /** The pseudonym its peers are registered under (not verified). */
      author: string | undefined;
      peers: string[];
      /** Seconds by the authors' clocks; 0 if undated. */
      start: number;
      end: number;
      frontiers: OpId[];
      /** Commit messages in it: a restore says where from. */
      messages: string[];
      /** The text is this version now. */
      current: boolean;
    }
  | {
      kind: "named";
      key: string;
      id: string;
      name: string;
      author: string;
      /** Milliseconds, by the namer's clock. */
      at: number;
      frontiers: OpId[];
      available: boolean;
      current: boolean;
    };

/** The history's list, derived from the two docs like `AnnotationIndex`:
 * computed at most once per version of them, however often it is read. */
export class HistoryModel {
  private cache:
    | {
        content: VersionVector;
        annotations: VersionVector;
        entries: HistoryEntry[];
      }
    | undefined;

  constructor(
    readonly contentDoc: LoroDoc,
    readonly annotationsDoc: LoroDoc,
  ) {}

  entries(): HistoryEntry[] {
    const content = this.contentDoc.version();
    const annotations = this.annotationsDoc.version();
    const cache = this.cache;
    if (
      cache &&
      cache.content.compare(content) === 0 &&
      cache.annotations.compare(annotations) === 0
    ) {
      return cache.entries;
    }
    const entries = computeEntries(this.contentDoc, this.annotationsDoc);
    this.cache = { content, annotations, entries };
    return entries;
  }
}

function computeEntries(
  contentDoc: LoroDoc,
  annotationsDoc: LoroDoc,
): HistoryEntry[] {
  count("history.list");
  const names = authors(annotationsDoc);
  const now = contentDoc.oplogVersion();
  const isCurrent = (frontiers: OpId[]) =>
    contentDoc.frontiersToVV(frontiers).compare(now) === 0;
  const entries: (HistoryEntry & { time: number })[] = [];
  for (const group of groupVersions(contentDoc, (peer) => names.get(peer))) {
    entries.push({
      kind: "group",
      key: `group:${JSON.stringify(group.frontiers)}`,
      author: group.author,
      peers: group.peers,
      start: group.start,
      end: group.end,
      frontiers: group.frontiers,
      messages: group.changes.flatMap((change) =>
        change.message === undefined ? [] : [change.message],
      ),
      current: isCurrent(group.frontiers),
      time: group.end * 1000,
    });
  }
  for (const version of listVersions(annotationsDoc, contentDoc)) {
    entries.push({
      kind: "named",
      key: `named:${version.id}`,
      ...version,
      current: version.available && isCurrent(version.frontiers),
      time: version.at,
    });
  }
  // Newest first; a name after the group it names when they tie.
  return entries
    .sort((x, y) => y.time - x.time || (x.kind === "named" ? 1 : -1))
    .map(({ time: _, ...entry }) => entry as HistoryEntry);
}
