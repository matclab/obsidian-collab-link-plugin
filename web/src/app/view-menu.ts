import { flushSync } from "svelte";
import { type Role, formatShortFingerprint } from "../../lib/src/index.js";
import { t } from "../i18n/index.js";
import type { IdentityKeys } from "../identity/identity-keys.js";
import { createLanguageField } from "../ui/menu/language-field.js";
import { createSigningKey } from "../ui/menu/signing-key.js";
import { VERSION } from "../version.js";
import type { OwnSignature } from "../view-model/own-signature.svelte.js";

/** The document menu's sections, each filled once its part exists. */
export interface DocumentMenu {
  files: HTMLElement;
  kept: HTMLElement;
  expiry: HTMLElement;
  identity: HTMLElement;
  /** Where the notifications are offered, if they are. */
  alerts?: HTMLElement;
  name: HTMLElement;
  danger: HTMLElement;
  /** The menu opened: the signing key asked for (ADR-0051). */
  opened(): void;
}

/** Builds the document menu in `body`, in this order: files, the writing
 * help, « Mes documents », expiry, identity, notifications, signing key,
 * name, language, and deleting apart, then the software's version
 * (README, "Versions"). Fills the parts it holds: the writing help's
 * entry, the signing key, the language. */
export function createDocumentMenu(
  body: HTMLElement,
  options: {
    role: Role;
    /** The writing help, for who writes. */
    help: { open(): void };
    /** Closes the menu, as the help opens. */
    close(): void;
    alerts: boolean;
    own: OwnSignature;
    /** The key the view signs with, if any. */
    identity: IdentityKeys | undefined;
    copy(text: string): Promise<void>;
    storage: Storage | undefined;
    reload(): void;
    stops: (() => void)[];
  },
): DocumentMenu {
  const { role, own } = options;
  const section = () => {
    const element = document.createElement("section");
    body.append(element);
    return element;
  };
  const files = section();
  if (role === "edit") {
    const open = document.createElement("button");
    open.className = "open-writing-help quiet";
    open.textContent = t().helpTitle;
    open.addEventListener("click", () => {
      options.close();
      options.help.open();
    });
    section().append(open);
  }
  const kept = section();
  const expiry = section();
  // The identity, beside the name chosen.
  const identity = section();
  const alerts = options.alerts ? section() : undefined;
  // The signing key, its fingerprint to give (ADR-0051): a read link
  // signs nothing.
  if (role !== "read") {
    const signingSection = section();
    signingSection.className = "signing-key";
    const signingKey = createSigningKey(signingSection, {
      own,
      copy: (text) => options.copy(text),
    });
    options.stops.push(() => signingKey.close());
  }
  const name = section();
  createLanguageField(section(), {
    storage: options.storage,
    reload: () => options.reload(),
  });
  const danger = section();
  const version = document.createElement("p");
  version.className = "app-version";
  version.textContent = t().appVersion(VERSION);
  body.append(version);
  return {
    files,
    kept,
    expiry,
    identity,
    ...(alerts && { alerts }),
    name,
    danger,
    // Its fingerprint to give, asked for as the menu opens — a read link
    // signs nothing, and draws no key.
    opened: () => {
      if (role === "read") return;
      void options.identity
        ?.signer()
        .then((signer) => {
          own.short = signer
            ? formatShortFingerprint(signer.fingerprint)
            : undefined;
          flushSync();
        })
        .catch(() => {});
    },
  };
}
