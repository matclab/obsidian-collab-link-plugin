/** What a page keeps on the device to resume where it was (ADR-0022 §1):
 * the Loro snapshots and the transport's state, captured together. Pure:
 * bytes in, bytes out — encryption and IndexedDB are elsewhere. */

/** One Loro channel: its snapshot and what the transport needs to resume
 * it (ADR-0011, ADR-0015, phase 5 R-A1/R-A2). */
export interface StoredChannel {
  channel: "content" | "annotations";
  /** A full Loro snapshot (ADR-0017). */
  snapshot: Uint8Array;
  /** Where to rejoin from: every entry up to it is applied in `snapshot`
   * (R-L3: frozen while operations wait for a dependency). */
  cursor: number;
  /** This client's Loro peer ids with operations not all acked, and the
   * counter up to which the server acked each. */
  own: { peer: string; acked: number }[];
  /** Adopted changes not yet acked, in order (R-A1, R-A2). */
  adopted: {
    change: Uint8Array;
    ownBefore: { peer: string; counter: number }[];
  }[];
}

/** The decisions channel (ADR-0013): the confirmed prefix, and what this
 * client proposed and hasn't seen acked. */
export interface StoredDecisions {
  cursor: number;
  confirmed: { seq: number; record: Uint8Array }[];
  outbox: Uint8Array[];
}

export interface LocalRecord {
  channels: StoredChannel[];
  decisions: StoredDecisions;
  /** What I set aside (ADR-0050 §4): an annotation's id and the id of its
   * last entry then. Absent in a record of before, which a page of before
   * reads without it (it ignores what it doesn't know). */
  setAside?: [string, string][];
}

const VERSION = 1;
const PREFIX = 5; // version byte, header length (u32)

/** `[version][header length][header JSON][bytes…]`: every byte array of the
 * record is replaced in the header by its index, and appended as is —
 * snapshots stay their own size, not a third bigger in base64. */
export function encodeRecord(record: LocalRecord): Uint8Array {
  const blobs: Uint8Array[] = [];
  const header = new TextEncoder().encode(
    // The raw value, read from its holder: a `Buffer` (a Uint8Array too)
    // reaches the replacer already turned into JSON by its `toJSON`.
    JSON.stringify(record, function (this: unknown, key, value: unknown) {
      const raw = (this as Record<string, unknown>)[key];
      if (!(raw instanceof Uint8Array)) return value;
      blobs.push(raw);
      return { b: blobs.length - 1 };
    }),
  );
  const lengths = new TextEncoder().encode(
    JSON.stringify(blobs.map((blob) => blob.length)),
  );
  const total =
    PREFIX +
    4 +
    lengths.length +
    header.length +
    blobs.reduce((sum, blob) => sum + blob.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out[0] = VERSION;
  view.setUint32(1, lengths.length);
  out.set(lengths, PREFIX);
  view.setUint32(PREFIX + lengths.length, header.length);
  let at = PREFIX + lengths.length + 4;
  out.set(header, at);
  at += header.length;
  for (const blob of blobs) {
    out.set(blob, at);
    at += blob.length;
  }
  return out;
}

/** The record, or `undefined` for anything else — another format version
 * included (R-L5: the caller leaves it alone). Accepts any byte view, a
 * `Uint8Array` of another realm too (`fake-indexeddb` under jsdom). */
export function decodeRecord(input: ArrayBufferView): LocalRecord | undefined {
  try {
    const bytes = new Uint8Array(
      input.buffer,
      input.byteOffset,
      input.byteLength,
    );
    if (bytes.length < PREFIX || bytes[0] !== VERSION) return undefined;
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    const lengthsSize = view.getUint32(1);
    const lengths: unknown = parseJson(bytes, PREFIX, lengthsSize);
    if (
      !Array.isArray(lengths) ||
      !lengths.every((n) => Number.isSafeInteger(n) && n >= 0)
    ) {
      return undefined;
    }
    const headerAt = PREFIX + lengthsSize + 4;
    const headerSize = view.getUint32(PREFIX + lengthsSize);
    const blobs: Uint8Array[] = [];
    let at = headerAt + headerSize;
    for (const length of lengths as number[]) {
      blobs.push(bytes.slice(at, at + length));
      at += length;
    }
    if (at !== bytes.length) return undefined;
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(headerAt, headerAt + headerSize),
      ),
      (_key, value: unknown) => {
        if (isBlobRef(value)) {
          const blob = blobs[value.b];
          if (!blob) throw new Error("no such blob");
          return blob;
        }
        return value;
      },
    ) as unknown;
    if (!isRecord(parsed)) return undefined;
    // A setting aside that doesn't read is lost, never the record.
    if (
      parsed.setAside !== undefined &&
      !isArrayOf(
        parsed.setAside,
        (pair): pair is [string, string] =>
          Array.isArray(pair) &&
          pair.length === 2 &&
          typeof pair[0] === "string" &&
          typeof pair[1] === "string",
      )
    ) {
      const { setAside: _, ...rest } = parsed;
      return rest;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function parseJson(bytes: Uint8Array, at: number, size: number): unknown {
  if (at + size > bytes.length) throw new Error("truncated");
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(at, at + size),
    ),
  );
}

function isBlobRef(value: unknown): value is { b: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).length === 1 &&
    Number.isSafeInteger((value as { b?: unknown }).b)
  );
}

const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const isBytes = (value: unknown): value is Uint8Array =>
  value instanceof Uint8Array;
const isPeer = (value: unknown): value is string =>
  typeof value === "string" && /^\d+$/.test(value);
const isArrayOf = <T>(value: unknown, item: (v: unknown) => v is T) =>
  Array.isArray(value) && value.every(item);
const has = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function isChannel(value: unknown): value is StoredChannel {
  return (
    has(value) &&
    (value.channel === "content" || value.channel === "annotations") &&
    isBytes(value.snapshot) &&
    isCount(value.cursor) &&
    isArrayOf(
      value.own,
      (own): own is StoredChannel["own"][number] =>
        has(own) && isPeer(own.peer) && isCount(own.acked),
    ) &&
    isArrayOf(
      value.adopted,
      (adopted): adopted is StoredChannel["adopted"][number] =>
        has(adopted) &&
        isBytes(adopted.change) &&
        isArrayOf(
          adopted.ownBefore,
          (before): before is { peer: string; counter: number } =>
            has(before) && isPeer(before.peer) && isCount(before.counter),
        ),
    )
  );
}

function isRecord(value: unknown): value is LocalRecord {
  if (!has(value) || !isArrayOf(value.channels, isChannel)) return false;
  const { decisions } = value;
  return (
    has(decisions) &&
    isCount(decisions.cursor) &&
    isArrayOf(
      decisions.confirmed,
      (entry): entry is StoredDecisions["confirmed"][number] =>
        has(entry) && isCount(entry.seq) && isBytes(entry.record),
    ) &&
    isArrayOf(decisions.outbox, isBytes)
  );
}
