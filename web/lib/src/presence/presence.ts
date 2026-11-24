import { Cursor, type LoroDoc } from "loro-crdt";
import { resolveCursor } from "../cursor.js";
import { count } from "../perf/index.js";
import { isWasmTrap } from "../transport/fatal.js";

/** How long another page's state is kept after it was received (ADR-0025
 * §5, ADR-0026: by the receiver's clock). */
export const PRESENCE_TIMEOUT_MS = 30_000;
/** How often the page's own state is sent again, unchanged. */
export const PRESENCE_HEARTBEAT_MS = 10_000;
/** The least time between two publications of a changing state. */
export const PRESENCE_INTERVAL_MS = 200;
/** How often expired states are looked for, while there are some. */
const PURGE_EVERY_MS = 5_000;

const MAX_NAME = 200;
const KEY = /^[0-9a-f]{32}$/;
const COLOR = /^#[0-9a-f]{6}$/;
const COLORS = [
  "#d1495b",
  "#00798c",
  "#edae49",
  "#66a182",
  "#8d6a9f",
  "#2e4057",
  "#e07a5f",
  "#3d85c6",
];

/** Another page, as this one shows it: positions in the text, or
 * `undefined` while the text they point at hasn't arrived (R-P4). */
export interface RemotePresence {
  key: string;
  /** Its page's counter: part of what it signs (ID-11). */
  seq: number;
  /** Not verified (ADR-0008), unless it is signed (06-identity.md). */
  name: string;
  color: string;
  anchor: number | undefined;
  head: number | undefined;
  /** Its signature and public key, unchecked (ID-7, ID-11). */
  sig?: Uint8Array;
  pk?: Uint8Array;
}

/** What a page signs of its state (docs/protocol/06-identity.md, §6.5). */
export interface PresenceSealed {
  key: string;
  seq: number;
  name: string;
  color: string;
}

/** A state as sent (ADR-0026), once validated. */
interface Wire {
  key: string;
  seq: number;
  state?: {
    name: string;
    color: string;
    anchor?: string;
    head?: string;
    sig?: Uint8Array;
    pk?: Uint8Array;
  };
}

/** What this page holds of another: its latest state (or its departure),
 * and when it was received, by this page's clock. */
interface Held {
  seq: number;
  state: Wire["state"];
  receivedAt: number;
}

/** The page's presence (ADR-0025, format of ADR-0026): its own state —
 * pseudonym, color, and selection as Loro cursors, stable under
 * concurrent edits — published through `publish` (encoded, not yet
 * encrypted), and the others' states, applied from `receive`. No clock in
 * what is sent: a counter per page orders its states, and a state expires
 * 30 s after it was received. One timer, `setTimeout` only (R-P3): at
 * most one publication per 200 ms while the state changes, one every 10 s
 * otherwise, expired states purged. Pure: no DOM, no network. */
export class Presence {
  private readonly held = new Map<string, Held>();
  private readonly key = randomKey();
  private readonly color: string;
  private seq = 0;
  private anchor: string | undefined;
  private head: string | undefined;
  private hasState = false;
  private dirty = false;
  private left = false;
  private lastPublished = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<() => void>();
  private notifying = false;
  private shownVersion = 0;
  /** States waiting for their signature, in the order of `seq`. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: {
      /** The document's text, whose cursors are shared. */
      doc: LoroDoc;
      /** Read at each publication: the pseudonym may change. */
      name: () => string;
      publish: (state: Uint8Array) => void;
      /** A Loro panic while resolving a cursor (R3): the page
       * halts (phase 9, L4). Without it, rethrown. */
      onTrap?: (error: unknown) => void;
      /** Signs a state (docs/protocol/06-identity.md, ID-11): its `sig`
       * and the signer's public key. States then leave in the order of
       * `seq`, each once signed; unsigned if
       * signing fails. Without it, at once, unsigned. */
      seal?: (
        state: PresenceSealed,
      ) => Promise<{ sig: Uint8Array; pk: Uint8Array } | undefined>;
    },
  ) {
    this.color = colorOf(this.key);
  }

  /** The page's selection, in the text's offsets. */
  setSelection(anchor: number, head: number): void {
    const text = this.options.doc.getText("content");
    const cursor = (at: number) => {
      const bytes = text.getCursor(at)?.encode();
      return bytes && toBase64(bytes);
    };
    this.anchor = cursor(anchor);
    this.head = anchor === head ? this.anchor : cursor(head);
    this.hasState = true;
    this.changed();
  }

  /** The pseudonym changed: sent with the next publication. */
  renamed(): void {
    if (this.hasState) this.changed();
  }

  /** A connection was just authenticated: the others may have forgotten
   * this page (R-P6), it publishes again at once. */
  connected(): void {
    if (!this.hasState) return;
    this.lastPublished = Number.NEGATIVE_INFINITY;
    this.changed();
  }

  /** Another page's state. One that doesn't validate is dropped; an older
   * one than held (by its page's counter) too. */
  receive(bytes: Uint8Array): void {
    const wire = decode(bytes);
    if (!wire || wire.key === this.key) return;
    const known = this.held.get(wire.key);
    if (known && known.seq >= wire.seq) return;
    if (!known || !sameShown(known.state, wire.state)) this.shownVersion++;
    this.held.set(wire.key, {
      seq: wire.seq,
      state: wire.state,
      receivedAt: Date.now(),
    });
    this.notify();
    this.schedule();
  }

  /** The page closes (R-P5): its departure goes out at once, then nothing
   * more. */
  leave(): void {
    if (this.left) return;
    this.left = true;
    this.clearTimer();
    if (!this.hasState) return;
    this.send({ v: 1, key: this.key, seq: ++this.seq, gone: true });
  }

  /** The other pages, resolved now: call it when showing them. */
  others(): RemotePresence[] {
    const doc = this.options.doc;
    const held = doc.oplogVersion();
    // Published by any editor or reviewer: resolved only if safe (D-37).
    const resolve = (encoded: string | undefined) => {
      if (encoded === undefined) return undefined;
      try {
        // Shown only: fast (E3).
        return resolveCursor(
          doc,
          Cursor.decode(fromBase64(encoded)),
          held,
          true,
        )?.offset;
      } catch (error) {
        if (!isWasmTrap(error)) return undefined;
        if (!this.options.onTrap) throw error;
        this.options.onTrap(error);
        return undefined;
      }
    };
    const others: RemotePresence[] = [];
    for (const [key, { seq, state }] of this.held) {
      if (!state) continue; // gone
      others.push({
        key,
        seq,
        name: state.name,
        color: state.color,
        anchor: resolve(state.anchor),
        head: resolve(state.head),
        ...(state.sig && { sig: state.sig }),
        ...(state.pk && { pk: state.pk }),
      });
    }
    return others.sort((a, b) => a.key.localeCompare(b.key));
  }

  /** Changes when what a cursor shows of the others does (R-P7): a
   * name, a color, a selection, a departure, an expiry — not a state sent
   * again unchanged, with only a new counter and signature. */
  shown(): number {
    return this.shownVersion;
  }

  /** Told when the others change (a state received, one expired), at
   * most once per microtask. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  destroy(): void {
    this.clearTimer();
    this.listeners.clear();
  }

  private changed(): void {
    if (this.left) return;
    this.dirty = true;
    this.schedule();
  }

  private publish(): void {
    const state = {
      v: 1,
      key: this.key,
      seq: ++this.seq,
      name: this.options.name(),
      color: this.color,
      ...(this.anchor && { anchor: this.anchor }),
      ...(this.head && { head: this.head }),
    };
    this.lastPublished = Date.now();
    this.dirty = false;
    const seal = this.options.seal;
    if (!seal) {
      this.send(state);
      return;
    }
    const { key, seq, name, color } = state;
    const signing = seal({ key, seq, name, color }).catch(() => undefined);
    this.queue = this.queue.then(async () => {
      const signed = await signing;
      // Gone meanwhile: the departure already left, nothing after it.
      if (this.left) return;
      this.send(
        signed
          ? { ...state, sig: toBase64(signed.sig), pk: toBase64(signed.pk) }
          : state,
      );
    });
  }

  private send(value: Record<string, unknown>): void {
    count("presence.publish");
    this.options.publish(new TextEncoder().encode(JSON.stringify(value)));
  }

  /** The one timer: publish when due, purge, and sleep until the next of
   * these. */
  private schedule(): void {
    if (this.left) return;
    this.clearTimer();
    const now = Date.now();
    const wakes: number[] = [];
    if (this.hasState) wakes.push(this.due());
    if (this.held.size > 0) wakes.push(now + PURGE_EVERY_MS);
    if (wakes.length === 0) return;
    const delay = Math.max(0, Math.min(...wakes) - now);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.tick();
    }, delay);
  }

  private due(): number {
    return (
      this.lastPublished +
      (this.dirty ? PRESENCE_INTERVAL_MS : PRESENCE_HEARTBEAT_MS)
    );
  }

  private tick(): void {
    const now = Date.now();
    let expired = false;
    for (const [key, { receivedAt, state }] of this.held) {
      if (now - receivedAt < PRESENCE_TIMEOUT_MS) continue;
      this.held.delete(key);
      if (state) expired = true;
    }
    if (expired) {
      this.shownVersion++;
      this.notify();
    }
    if (this.hasState && now >= this.due()) this.publish();
    this.schedule();
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private notify(): void {
    if (this.notifying) return;
    this.notifying = true;
    queueMicrotask(() => {
      this.notifying = false;
      for (const listener of this.listeners) listener();
    });
  }
}

function sameShown(a: Wire["state"], b: Wire["state"]): boolean {
  if (!a || !b) return a === b;
  return (
    a.name === b.name &&
    a.color === b.color &&
    a.anchor === b.anchor &&
    a.head === b.head
  );
}

/** A state as received, validated field by field (ADR-0026), or
 * `undefined`. */
function decode(bytes: Uint8Array): Wire | undefined {
  let value: unknown;
  try {
    // JSON text is UTF-8 (RFC 8259): a state that isn't is ignored (D-32).
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { v, key, seq, gone, name, color, anchor, head, sig, pk } =
    value as Record<string, unknown>;
  if (v !== 1 || typeof key !== "string" || !KEY.test(key)) return undefined;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
    return undefined;
  }
  if (gone === true) return { key, seq };
  if (typeof name !== "string" || name.length > MAX_NAME) return undefined;
  if (typeof color !== "string" || !COLOR.test(color)) return undefined;
  const cursor = (field: unknown) =>
    field === undefined || (typeof field === "string" && isBase64(field));
  if (!cursor(anchor) || !cursor(head)) return undefined;
  // ID-11: a malformed sig or pk is no signature; the state is kept.
  const decoded = (field: unknown) =>
    typeof field === "string" && isBase64(field)
      ? fromBase64(field)
      : undefined;
  const sigBytes = decoded(sig);
  const pkBytes = decoded(pk);
  return {
    key,
    seq,
    state: {
      name,
      color,
      ...(typeof anchor === "string" && { anchor }),
      ...(typeof head === "string" && { head }),
      ...(sigBytes && { sig: sigBytes }),
      ...(pkBytes && { pk: pkBytes }),
    },
  };
}

/** Standard base64, padded (D-31: as D-24), at most 256 characters. */
function isBase64(text: string): boolean {
  return (
    text.length <= 256 &&
    text.length % 4 === 0 &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(text)
  );
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** A color of the palette, the same for a key on every page. */
function colorOf(key: string): string {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length] ?? "#888888";
}
