import {
  type InfoEvent,
  type InputEvent,
  type Snapshot,
  TRACE_VERSION,
  type Trace,
  type TraceEntry,
} from "./format.js";

/** Records a client's trace (`format.ts`). Enabled with `?trace` in the
 * page URL; everything stays in memory until downloaded. */
export class TraceRecorder {
  private readonly entries: TraceEntry[] = [];
  private readonly uuids: string[] = [];
  private readonly started = Date.now();

  constructor(
    private readonly meta: {
      documentId: string;
      author: string;
      peers: { content: string; annotations: string };
    },
    private readonly state: () => Snapshot,
  ) {}

  /** Call right *before* applying the input, so `before` is the state the
   * input found. */
  input(event: InputEvent): void {
    this.entries.push({
      ...event,
      at: Date.now() - this.started,
      before: this.state(),
    });
  }

  info(event: InfoEvent): void {
    this.entries.push({ ...event, at: Date.now() - this.started });
  }

  uuid(value: string): void {
    this.uuids.push(value);
  }

  toTrace(): Trace {
    return {
      version: TRACE_VERSION,
      ...this.meta,
      startedAt: this.started,
      uuids: [...this.uuids],
      entries: [...this.entries],
      final: this.state(),
    };
  }

  /** Records every UUID drawn (replayed as is, for identical ids) and
   * every error that would otherwise only reach the console — including
   * the ones Loro and CodeMirror swallow from their callbacks
   *. */
  captureGlobals(target: Window & typeof globalThis): void {
    const randomUUID = target.crypto.randomUUID.bind(target.crypto);
    target.crypto.randomUUID = () => {
      const value = randomUUID();
      this.uuid(value);
      return value;
    };
    const consoleError = target.console.error.bind(target.console);
    target.console.error = (...args: unknown[]) => {
      this.info({ kind: "error", message: args.map(describe).join(" ") });
      consoleError(...args);
    };
    target.addEventListener("error", (event) => {
      this.info({
        kind: "error",
        message: describe(event.error ?? event.message),
      });
    });
    target.addEventListener("unhandledrejection", (event) => {
      this.info({ kind: "error", message: describe(event.reason) });
    });
  }
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
