/** The page's attention (ADR-0060 §1): looked at while visible and
 * focused; the system's notifications, where the browser makes them from
 * a page (not Chrome on Android, which wants a service worker's: none
 * there); the count of what awaits me in front of the tab's title, which
 * never carries the document's — it would go to the browser's history. */
import type { AlertPermission, Attention } from "../ui/alerts/alerts.js";

/** What it takes of the browser: `Notification`, if it has one. */
export interface AttentionGlobals {
  window: Pick<Window, "addEventListener" | "removeEventListener" | "focus">;
  document: Pick<
    Document,
    "visibilityState" | "hasFocus" | "addEventListener" | "title"
  >;
  Notification?: {
    readonly permission: NotificationPermission;
    requestPermission(): Promise<NotificationPermission>;
    new (
      title: string,
      options: { body: string; tag: string },
    ): Pick<Notification, "close" | "onclick">;
  };
}

export function browserAttention(globals: AttentionGlobals): Attention {
  const { window, document } = globals;
  const Notify = globals.Notification;
  const title = document.title;
  const listeners = new Set<() => void>();
  const tell = () => {
    for (const listener of [...listeners]) listener();
  };
  window.addEventListener("focus", tell);
  window.addEventListener("blur", tell);
  document.addEventListener("visibilitychange", tell);
  return {
    watched: () =>
      document.visibilityState === "visible" && document.hasFocus(),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    permission: (): AlertPermission => Notify?.permission ?? "unsupported",
    async request() {
      if (!Notify) return "unsupported";
      return await Notify.requestPermission();
    },
    notify({ tag, title, body, onClick }) {
      if (!Notify) return () => {};
      let shown: Pick<Notification, "close" | "onclick">;
      try {
        shown = new Notify(title, { body, tag });
      } catch {
        // A browser that makes them only from a service worker.
        return () => {};
      }
      shown.onclick = () => {
        window.focus();
        shown.close();
        onClick();
      };
      return () => shown.close();
    },
    count(awaiting) {
      document.title = awaiting > 0 ? `(${awaiting}) ${title}` : title;
    },
  };
}
