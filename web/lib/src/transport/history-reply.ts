/** A decisions record confirmed by a history reply, with its journal seq. */
export interface ConfirmedRecord {
  seq: number;
  record: Uint8Array;
}

/** What a decrypted decisions reply confirms past `cursor`, in seq order,
 * and the cursor after it. Delivered synchronously, filtered against the
 * cursor: each reply is the complete suffix after a `since` no greater than
 * the cursor, so the union of batches stays a gapless prefix — whatever
 * order replies in progress end decrypting in. */
export function confirmedBatch(
  decrypted: ConfirmedRecord[],
  cursor: number,
): { batch: ConfirmedRecord[]; cursor: number } {
  const batch = decrypted
    .filter((entry) => entry.seq > cursor)
    .sort((x, y) => x.seq - y.seq);
  return { batch, cursor: batch.at(-1)?.seq ?? cursor };
}

/** A decrypted reply grouped by channel, in the order of `runtimes`: the
 * updates to import in one batch each (docs/phase-4ter-*.md, decision 3)
 * and the highest seq the reply holds for it — an entry that couldn't be
 * read (`plaintext` absent) counts there too (decision 10). Channels the
 * reply holds nothing of are left out. */
export function groupReply<R>(
  decrypted: { runtime: R; seq: number; plaintext: Uint8Array | undefined }[],
  runtimes: readonly R[],
): { runtime: R; updates: Uint8Array[]; seq: number }[] {
  return runtimes.flatMap((runtime) => {
    const mine = decrypted.filter((entry) => entry.runtime === runtime);
    if (mine.length === 0) return [];
    const updates = mine.flatMap((entry) =>
      entry.plaintext ? [entry.plaintext] : [],
    );
    return [{ runtime, updates, seq: Math.max(...mine.map((e) => e.seq)) }];
  });
}
