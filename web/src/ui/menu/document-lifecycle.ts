import { flushSync, mount, unmount } from "svelte";
import { MAX_EXPIRY_SECONDS, type Role } from "../../../lib/src/index.js";
import { formatDate, t } from "../../i18n/index.js";
import Danger from "./DeleteDocument.svelte";
import Section from "./DocumentLifecycle.svelte";

export interface DocumentLifecycle {
  /** The expiry learned at an authentication (`onExpiry`). */
  setExpiry(expiresAt: number | null): void;
  /** The document was deleted (`4404`): nothing more to offer. */
  deleted(): void;
  destroy(): void;
}

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

/** The expiry as the page says it (ADR-0023 §2): the date in local time,
 * and how far it is from `nowMs`. */
export function describeExpiry(
  expiresAt: number | null,
  nowMs: number,
): string {
  if (expiresAt === null) return t().keptUntilDeleted;
  const date = formatDate(expiresAt * 1000);
  return t().deletedOn(date, howFar(expiresAt - nowMs / 1000));
}

function howFar(seconds: number): string {
  if (seconds <= 0) return t().due;
  if (seconds < HOUR) return t().inMinutes(Math.ceil(seconds / 60));
  if (seconds < DAY) return t().inHours(Math.round(seconds / HOUR));
  return t().inDays(Math.round(seconds / DAY));
}

const UNITS: Record<string, number> = {
  hours: HOUR,
  days: DAY,
  weeks: 7 * DAY,
};

/** Mounts the lifecycle section (`DocumentLifecycle.svelte`). Setting an
 * expiry asks `confirm` first (it is a deletion to come); deleting is
 * confirmed by typing a word; removing an expiry asks nothing. `setExpiry` and `deleteDocument`
 * are the connection's (they fail when it isn't up). */
export function createDocumentLifecycle(
  container: Element,
  options: {
    role: Role;
    expiresAt: number | null;
    /** Milliseconds, like `Date.now`. */
    now: () => number;
    confirm: (message: string) => boolean;
    setExpiry: (inSeconds: number | null) => Promise<number | null>;
    deleteDocument: () => void;
    /** Where deleting goes, apart (the end of the document menu);
     * default: after the expiry. */
    dangerParent?: Element;
  },
): DocumentLifecycle {
  const describe = (expiresAt: number | null) =>
    describeExpiry(expiresAt, options.now());
  const request = async (inSeconds: number | null) => {
    try {
      const expiresAt = await options.setExpiry(inSeconds);
      section.show(expiresAt, describe(expiresAt));
    } catch {
      section.fail(t().expiryNotConfirmed);
    }
    flushSync();
  };
  const expireIn = (seconds: number) => {
    if (!Number.isInteger(seconds) || seconds < 1) return;
    if (seconds > MAX_EXPIRY_SECONDS) {
      section.fail(t().expiryTooFar);
      return;
    }
    const at = formatDate(options.now() + seconds * 1000);
    const accepted = options.confirm(t().expiryConfirm(at));
    if (accepted) void request(seconds);
  };
  const section = mount(Section, {
    target: container,
    props: {
      role: options.role,
      onExpireIn(count: string, unit: string) {
        const n = Number(count);
        const perUnit = UNITS[unit];
        if (count.trim() === "" || !Number.isInteger(n) || n < 1 || !perUnit) {
          section.fail(t().expiryWholeNumber);
          return;
        }
        expireIn(n * perUnit);
      },
      onExpireOn(value: string) {
        const at = value === "" ? Number.NaN : new Date(value).getTime();
        const seconds = Math.ceil((at - options.now()) / 1000);
        if (!(seconds >= 1)) {
          section.fail(t().expiryInFuture);
          return;
        }
        expireIn(seconds);
      },
      onRemove() {
        void request(null);
      },
    },
  });
  // Typing the word is the confirmation: no other question.
  const danger =
    options.role === "edit"
      ? mount(Danger, {
          target: options.dangerParent ?? container,
          props: {
            onDelete() {
              try {
                options.deleteDocument();
              } catch {
                danger?.fail(t().notConnectedNotDeleted);
                flushSync();
              }
            },
          },
        })
      : undefined;
  section.show(options.expiresAt, describe(options.expiresAt));
  flushSync();
  return {
    setExpiry(expiresAt) {
      section.show(expiresAt, describe(expiresAt));
      flushSync();
    },
    deleted() {
      section.deleted();
      danger?.deleted();
      flushSync();
    },
    destroy() {
      void unmount(section);
      if (danger) void unmount(danger);
    },
  };
}
