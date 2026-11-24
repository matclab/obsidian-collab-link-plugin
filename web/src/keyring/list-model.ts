/** « Mes documents » as the list shows it: pure, from the keyring's
 * entries. */
import type { KeyringEntry } from "../../lib/src/index.js";

export type ListSort = "recent" | "title";

const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase();

/** Excluded entries never shown (KR-24); the others filtered on title and
 * identifier, then sorted: by last opening (never opened last), or by
 * title in `language`'s order (untitled last). */
export function visibleEntries(
  entries: readonly KeyringEntry[],
  options: { filter: string; sort: ListSort; language?: string },
): KeyringEntry[] {
  const wanted = fold(options.filter.trim());
  const shown = entries.filter(
    (e) =>
      !e.excluded &&
      (!wanted ||
        fold(e.title ?? "").includes(wanted) ||
        e.documentId.includes(wanted)),
  );
  const collator = new Intl.Collator(options.language, { sensitivity: "base" });
  return shown.sort((a, b) => {
    if (options.sort === "title") {
      if (a.title === null || b.title === null)
        return a.title === null ? (b.title === null ? 0 : 1) : -1;
      return collator.compare(a.title, b.title);
    }
    return (
      (b.openedAt ?? Number.NEGATIVE_INFINITY) -
        (a.openedAt ?? Number.NEGATIVE_INFINITY) ||
      a.documentId.localeCompare(b.documentId)
    );
  });
}
