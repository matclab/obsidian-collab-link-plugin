/** What awaits my reply, kept up to date (ADR-0050 §1, §6, §7): derived
 * from the shared annotations index, the verdicts of the signatures, who I
 * am, the decisions and what I set aside — computed at most once per
 * change of one of them, never for a keystroke, and told at most once per
 * microtask. While a verification runs, an annotation whose thread holds
 * an entry it may change keeps the state it had (absent if none): it
 * neither comes in nor goes out on a verdict not yet known. */
import type {
  Annotation,
  AnnotationIndex,
  LocalDecisions,
  Role,
  SignatureIndex,
  SignatureView,
} from "../../lib/src/index.js";
import { count } from "../perf/index.js";
import { type Me, awaits, threadOf } from "./awaiting.js";

/** Who I am now: the same object while nothing changed. */
export interface MeSource {
  current(): Me;
  subscribe(listener: () => void): () => void;
}

/** What I set aside (ADR-0050 §4): an annotation's id → the id of its
 * last entry then. */
export interface SetAsideSource {
  get(annotationId: string): string | undefined;
  /** Moves at each change. */
  readonly version: number;
  subscribe(listener: () => void): () => void;
}

const UNSIGNED_VIEW: SignatureView = {
  of: () => ({ signed: false }),
  version: () => "",
  settled: true,
};

const NONE: ReadonlySet<string> = Object.freeze(new Set<string>());

export class AwaitingIndex {
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribes: (() => void)[];
  private scheduled = false;
  /** Moves with each change of the annotations' map — their threads and
   * statuses —, not of the tables beside it: the first keystroke
   * registers the page's peers there. */
  private threads = 0;
  private last:
    | {
        annotations: number;
        /** The verdicts of the threads, and whether they are all known:
         * a name registered in `peers` changes the view, not them. */
        verdicts: string;
        decisions: number;
        me: Me;
        setAside: number;
        result: ReadonlySet<string>;
        aside: ReadonlySet<string>;
      }
    | undefined;

  constructor(
    private readonly options: {
      annotations: AnnotationIndex;
      decisions: Pick<
        LocalDecisions,
        "confirmed" | "outcome" | "version" | "subscribe"
      >;
      /** None: every entry reads unsigned. */
      signatures?: SignatureIndex;
      me: MeSource;
      setAside?: SetAsideSource;
      /** A reader can't reply: nothing awaits it. */
      role: Role;
    },
  ) {
    const notify = () => this.notify();
    this.unsubscribes = [
      options.annotations.annotationsDoc.subscribe((batch) => {
        if (batch.events.some((event) => event.path[0] === "annotations")) {
          this.threads++;
          this.notify();
        }
      }),
      options.decisions.subscribe(notify),
      options.me.subscribe(notify),
      ...(options.signatures ? [options.signatures.subscribe(notify)] : []),
      ...(options.setAside ? [options.setAside.subscribe(notify)] : []),
    ];
  }

  /** The ids of the annotations that await my reply. */
  current(): ReadonlySet<string> {
    return this.computed().result;
  }

  /** Those that would, but for my setting them aside: to put back. */
  aside(): ReadonlySet<string> {
    return this.computed().aside;
  }

  private computed(): {
    result: ReadonlySet<string>;
    aside: ReadonlySet<string>;
  } {
    const { options } = this;
    if (options.role === "read") return { result: NONE, aside: NONE };
    const annotations = this.threads;
    const signatures = options.signatures?.current() ?? UNSIGNED_VIEW;
    const verdicts = `${signatures.version("annotation", "reply")}|${signatures.settled}`;
    const decisions = options.decisions.version;
    const me = options.me.current();
    const setAside = options.setAside?.version ?? 0;
    const last = this.last;
    if (
      last &&
      last.annotations === annotations &&
      last.verdicts === verdicts &&
      last.decisions === decisions &&
      last.me === me &&
      last.setAside === setAside
    ) {
      return last;
    }
    count("awaiting.compute");
    const before = last?.result ?? NONE;
    const result = new Set<string>();
    const aside = new Set<string>();
    for (const annotation of options.annotations.current().annotations) {
      if (!this.open(annotation)) continue;
      count("awaiting.thread");
      if (!signatures.settled && mayChange(annotation, signatures)) {
        if (before.has(annotation.id)) result.add(annotation.id);
        if (last?.aside.has(annotation.id)) aside.add(annotation.id);
        continue;
      }
      const thread = threadOf(annotation, signatures, me);
      if (awaits(thread, options.setAside?.get(annotation.id))) {
        result.add(annotation.id);
      } else if (awaits(thread)) {
        aside.add(annotation.id);
      }
    }
    const computed = {
      annotations,
      verdicts,
      decisions,
      me,
      setAside,
      result,
      aside,
    };
    this.last = computed;
    return computed;
  }

  /** Told at most once per microtask when `current()` may have changed. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  destroy(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.listeners.clear();
  }

  /** Open, and not decided: neither confirmed, nor proposed by me. */
  private open(annotation: Annotation): boolean {
    const { decisions } = this.options;
    return (
      annotation.status === "open" &&
      decisions.outcome(annotation.id) === undefined &&
      !decisions.confirmed(
        annotation.id,
        annotation.type === "comment" ? "comment" : "suggestion",
      )
    );
  }

  private notify(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      for (const listener of [...this.listeners]) listener();
    });
  }
}

/** Whether an entry of the thread carries a signature that doesn't read
 * signed yet: its verdict may still come. */
function mayChange(annotation: Annotation, signatures: SignatureView): boolean {
  if (annotation.sig && !signatures.of("annotation", annotation.id).signed) {
    return true;
  }
  return annotation.replies.some(
    (reply) =>
      reply.sig !== undefined &&
      (reply.id === undefined ||
        !signatures.of("reply", `${annotation.id}/${reply.id}`).signed),
  );
}
