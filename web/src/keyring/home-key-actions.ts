/** What the home does with a list's key: keeping a new list, finding one by its
 * key or a code's address, changing the key, pasting the key of a list
 * gone (KR-30) or keeping it under a new one (cas 12), showing the key;
 * a document removed, a renewed link pasted. Acts on the home's session
 * through `HomeCore`. */
import { flushSync } from "svelte";
import {
  type CreatedKeyring,
  type KeyringCredentials,
  excludeDocument,
  newKeyringDoc,
  parseKeyringLink,
  rememberLink,
} from "../../lib/src/index.js";
import { t } from "../i18n/index.js";
import { sessionOptions } from "./environment.js";
import type { HomePairing } from "./home-pairing.js";
import { pairingIn } from "./home-pairing.js";
import type { HomeCore } from "./home.js";
import { keyText } from "./ref.js";
import { KeyringSession } from "./session.js";

export function homeKeyActions(
  core: HomeCore,
  pairing: Pick<HomePairing, "pair" | "end">,
): {
  onKeep(): void;
  onFind(text: string): void;
  onRemove(documentId: string): void;
  onNewLink(documentId: string, link: string): void;
  onRecreate(): void;
  onChangeKey(): void;
  onNewKey(text: string): void;
  onShowKey(): void;
} {
  const { options, onStatus } = core;
  /** A new keyring holding `doc`, its key shown once; in place of the one
   * stored, gone from the server (cas 12), if `replacing`. */
  const keepUnderNewKey = (doc = newKeyringDoc(), replacing = false) =>
    core.busy(async () => {
      if (!options.keyring) return;
      let created: CreatedKeyring;
      try {
        created = await options.createKeyring();
      } catch {
        core.say(t().keyringOffline);
        flushSync();
        return;
      }
      const adopted = await KeyringSession.adopt(
        sessionOptions(options.keyring, options.apiBase, onStatus),
        created,
        doc,
        replacing,
      );
      if (!adopted) {
        await core.takenMeanwhile();
        return;
      }
      core.use(adopted);
      core.say("");
      core.screen().reveal(created.link);
      flushSync();
    });

  return {
    onKeep: () => void keepUnderNewKey(),
    onFind: (text: string) =>
      void core.busy(async () => {
        if (!options.keyring) return;
        const view = core.screen();
        // The address of a code, copied from another device (KR-35):
        // where no camera opens it (the plugin).
        const address = pairingIn(text, options.apiBase);
        if (address) {
          view.setFindError("");
          await pairing.pair(address);
          return;
        }
        let credentials: KeyringCredentials;
        try {
          credentials = parseKeyringLink(text);
        } catch {
          view.setFindError(t().keyInvalid);
          flushSync();
          return;
        }
        view.setFindError("");
        // Its statuses said once it is this device's list: before, a
        // `404` is a key mistyped, not a list gone.
        let adopted = false;
        const found = await KeyringSession.adopt(
          sessionOptions(options.keyring, options.apiBase, (status) => {
            if (adopted) onStatus(status);
          }),
          credentials,
        );
        if (!found) {
          await core.takenMeanwhile();
          return;
        }
        const status = await found.sync();
        if (status === "missing" || status === "unreadable") {
          // A key mistyped, or of another server: forgotten at once —
          // it, not one another tab put here meanwhile.
          found.close();
          await options.keyring.local.forget(credentials);
          view.setFindError(
            status === "missing" ? t().keyNotFound : t().keyUnreadable,
          );
          flushSync();
          return;
        }
        adopted = true;
        core.use(found);
        onStatus(status);
      }),
    onRemove: (documentId: string) => {
      const session = core.session();
      if (!session || !options.confirm(t().removeConfirm)) return;
      void session.change((doc) =>
        excludeDocument(doc, documentId, options.now()),
      );
    },
    onNewLink: (documentId: string, link: string) => {
      const session = core.session();
      if (!session) return;
      let id: string | null = null;
      try {
        const url = new URL(link.trim());
        // A link to this server only: one elsewhere would open another
        // page, perhaps a lookalike, from « Mes documents ».
        if (url.origin === new URL(options.apiBase).origin) {
          id = url.searchParams.get("doc");
        }
      } catch {}
      if (id !== documentId) {
        core.screen().setNewLinkError(documentId, t().linkNotThisDocument);
        flushSync();
        return;
      }
      core.screen().setNewLinkError(documentId, "");
      void session.change(
        (doc) =>
          void rememberLink(doc, link.trim(), {
            explicit: true,
            at: options.now(),
          }),
      );
    },
    onRecreate: () => {
      // Cas 12: the same content, under a new key.
      const doc = core.session()?.doc;
      void keepUnderNewKey(doc ?? newKeyringDoc(), true);
    },
    onChangeKey: () => {
      const current = core.session();
      if (
        !current ||
        !options.keyring ||
        !options.confirm(t().changeKeyConfirm)
      )
        return;
      void core.busy(async () => {
        let created: CreatedKeyring;
        try {
          created = await options.createKeyring();
        } catch {
          core.say(t().keyringOffline);
          flushSync();
          return;
        }
        // A code shown carries the old key.
        pairing.end();
        // KR-29: the new keyring takes the copy, the old one goes once
        // the new one is written.
        const next = await KeyringSession.rotate(current, created);
        if (!next) {
          // Another tab put another list here meanwhile: it is shown,
          // and the keyring just created, which holds nothing, goes.
          const env = options.keyring;
          if (env)
            void sessionOptions(env, options.apiBase)
              .remove(created)
              .catch(() => {});
          await core.takenMeanwhile();
          return;
        }
        core.use(next);
        core.screen().reveal(created.link);
        core.say(t().keyChanged);
        flushSync();
        await next.sync();
        if (await next.retiring()) {
          core.say(t().oldKeyStillOpens);
          flushSync();
        }
      });
    },
    onNewKey: (text: string) =>
      void core.busy(async () => {
        const gone = core.session();
        if (!gone || !options.keyring) return;
        let credentials: KeyringCredentials;
        try {
          credentials = parseKeyringLink(text);
        } catch {
          core.say(t().keyInvalid, true);
          flushSync();
          return;
        }
        // KR-30: this device's copy merges into the keyring of that key.
        const next = await KeyringSession.adopt(
          sessionOptions(options.keyring, options.apiBase, onStatus),
          credentials,
          gone.doc,
          true,
        );
        if (!next) return;
        const status = await next.sync();
        if (status === "missing" || status === "unreadable") {
          next.close();
          // The gone keyring stays this device's copy.
          await options.keyring.local.replace(gone.ref, gone.doc);
          core.say(
            status === "missing" ? t().keyNotFound : t().keyUnreadable,
            true,
          );
          flushSync();
          return;
        }
        core.use(next);
        onStatus(status);
      }),
    onShowKey: () => {
      const session = core.session();
      if (!session) return;
      core.screen().reveal(keyText(session.ref));
      flushSync();
    },
  };
}
