/** A view's attention in Obsidian (ADR-0060 §1): looked at while Obsidian's
 * window has the focus and the view's leaf is the active one; Electron's
 * notifications, a click bringing the window and the leaf forward. No count:
 * the window's title is Obsidian's. Its listeners live while someone listens,
 * so closing the view lets them go. */
import type { AlertPermission, Attention } from "../../web/src/embed.js";

export interface LeafAttentionHost {
  window: Pick<Window, "addEventListener" | "removeEventListener" | "focus">;
  document: Pick<Document, "hasFocus">;
  Notification?: {
    readonly permission: NotificationPermission;
    requestPermission(): Promise<NotificationPermission>;
    new (
      title: string,
      options: { body: string; tag: string },
    ): Pick<Notification, "close" | "onclick">;
  };
  /** The view's leaf is the workspace's active one. */
  active(): boolean;
  /** Told when the active leaf changes; gives its removal. */
  onActiveChange(listener: () => void): () => void;
  /** Brings the view's leaf forward. */
  reveal(): void;
}

export function leafAttention(host: LeafAttentionHost): Attention {
  const Notify = host.Notification;
  return {
    watched: () => host.document.hasFocus() && host.active(),
    subscribe(listener) {
      host.window.addEventListener("focus", listener);
      host.window.addEventListener("blur", listener);
      const stop = host.onActiveChange(listener);
      return () => {
        host.window.removeEventListener("focus", listener);
        host.window.removeEventListener("blur", listener);
        stop();
      };
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
        return () => {};
      }
      shown.onclick = () => {
        host.window.focus();
        host.reveal();
        shown.close();
        onClick();
      };
      return () => shown.close();
    },
  };
}
