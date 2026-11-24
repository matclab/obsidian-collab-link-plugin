import { flushSync, mount, unmount } from "svelte";
/** The identity line of the document menu: what the
 * page says of the identity signed in, and of what this browser signs —
 * the name, or why not yet and the gesture that makes it appear. A pure
 * judgement of three states: the sign-in (`SignIn`), the list here
 * (`DocumentAssociation`), the attestation (`Attestor`). */
import type { AttestorState } from "../../account/attestor.js";
import type { AccountState } from "../../account/sign-in.js";
import type { NotYet } from "../../account/sign-to-name.js";
import { t } from "../../i18n/index.js";
import type { DocumentSituation } from "../../keyring/document-association.js";
import View from "./IdentityLine.svelte";

export type IdentityLine =
  /** No gateway that answers: as before, nothing said. */
  | { kind: "hidden" }
  /** « S'identifier »: `ready` once the click opens at once. */
  | { kind: "sign-in"; ready: boolean }
  | { kind: "pending" }
  /** The name, attested: what is written carries it. */
  | { kind: "attested"; org?: string; who: string }
  /** Signed in, not the name yet: the list here is to associate (home
   * page), to open here (home page), another identity's; the identity to
   * confirm (a recent sign-in); the key no longer attested. */
  | { kind: "associate"; who: string }
  | { kind: "open-here"; who: string }
  | { kind: "other"; who: string }
  | { kind: "confirm"; who: string }
  /** The key refused: « Nouvelle clé de signature », its
   * replacement under way or found offline. */
  | { kind: "refused"; who: string; replacing?: "busy" | "offline" }
  /** Signed in, the list or the attestation not known: the gateway out
   * of reach — to try again. */
  | { kind: "unconfirmed"; who: string }
  /** Signed in, nothing known yet of the name. */
  | { kind: "signed-in"; who: string };

export function identityLine(input: {
  account: AccountState;
  list: DocumentSituation;
  attestation?: AttestorState;
  orgName?: string;
  /** A new key asked for (NK6). */
  replacing?: "busy" | "offline";
}): IdentityLine {
  const { account, list, attestation } = input;
  switch (account.kind) {
    case "unavailable":
      return { kind: "hidden" };
    case "signed-out":
      return { kind: "sign-in", ready: account.ready };
    case "pending":
      return { kind: "pending" };
  }
  const who = t().identityWho(account.name, account.email);
  switch (list.kind) {
    case "ask":
      return { kind: "associate", who };
    case "open-here":
      return { kind: "open-here", who };
    case "other":
      return { kind: "other", who };
    case "unknown":
      return { kind: "unconfirmed", who };
    case "associated":
      if (attestation === "attested") {
        return {
          kind: "attested",
          ...(input.orgName && { org: input.orgName }),
          who,
        };
      }
      if (attestation === "needs-recent") return { kind: "confirm", who };
      if (attestation === "refused") {
        return {
          kind: "refused",
          who,
          ...(input.replacing && { replacing: input.replacing }),
        };
      }
      if (attestation === "unattested") return { kind: "unconfirmed", who };
  }
  return { kind: "signed-in", who };
}

/** Mounts the identity line (`IdentityLine.svelte`) and keeps it to the
 * states it judges: shown again whenever the sign-in or the list here
 * changes, the attestation asked for when the list is the identity's. */
export function createIdentityLine(
  container: Element,
  options: {
    homeHref: string;
    /** The host's own list, opened instead of the home page. */
    onHome?: () => void;
    orgName?: string;
    gate: {
      state(): AccountState;
      start(options?: { recent?: boolean }): void;
      cancel(): void;
      subscribe(listener: () => void): () => void;
      /** Whether the token is recent now (ID-28). */
      recent?(): boolean;
    };
    association?: {
      situation(): DocumentSituation;
      subscribe(listener: () => void): () => void;
      /** Decides the list again, its listeners told. */
      retry(): Promise<void>;
    };
    /** The attestation got or renewed (`Trust.refresh`), and its state. */
    attestation(): Promise<AttestorState | undefined>;
    /** Told when the attestation is to be judged again (`Trust.subscribe`,
     * NK3). */
    judgeAgain?: (listener: () => void) => () => void;
    /** Replaces the refused key (`IdentityKeys.replaceRefused`, NK4); its
     * account read at once, in the click. */
    newKey?: () => Promise<"drawn" | "replaced" | "offline" | "none">;
    /** Told of each line shown. */
    onLine?: (line: IdentityLine) => void;
  },
): { close(): void; retry(): void; newKey(): void } {
  const view = mount(View, {
    target: container,
    props: {
      homeHref: options.homeHref,
      ...(options.onHome && { onHome: options.onHome }),
      onSignIn: () => options.gate.start(),
      // In the click, recent (IC1).
      onConfirm: () => options.gate.start({ recent: true }),
      onCancel: () => options.gate.cancel(),
      onRetry: () => retry(),
      onNewKey: () => newKey(),
    },
  });
  let attestation: AttestorState | undefined;
  let replacing: "busy" | "offline" | undefined;
  let turn = 0;
  const render = () => {
    const line = identityLine({
      account: options.gate.state(),
      list: options.association?.situation() ?? { kind: "signed-out" },
      ...(attestation && { attestation }),
      ...(options.orgName && { orgName: options.orgName }),
      ...(replacing && { replacing }),
    });
    view.show(line, options.orgName);
    flushSync();
    options.onLine?.(line);
  };
  const update = () => {
    render();
    const signedIn = options.gate.state().kind === "signed-in";
    const associated = options.association?.situation().kind === "associated";
    if (!signedIn || !associated) {
      attestation = undefined;
      return;
    }
    const mine = ++turn;
    void options.attestation().then((state) => {
      if (mine !== turn) return;
      attestation = state;
      render();
    });
  };
  // The list decided again if not known (its listeners show it), else
  // the attestation asked again.
  const retry = () => {
    const association = options.association;
    if (association?.situation().kind === "unknown") {
      void association.retry();
    } else update();
  };
  // NK6, in the click: the key replaced (its account read now), and the
  // recent sign-in its registration needs opened at once (ADR-0041); the
  // attestation asked again once replaced, and again once signed in.
  const newKey = () => {
    if (!options.newKey || replacing === "busy") return;
    const replaced = options.newKey();
    if (!(options.gate.recent?.() ?? false)) {
      options.gate.start({ recent: true });
    }
    replacing = "busy";
    render();
    void replaced
      .catch(() => "offline" as const)
      .then((result) => {
        replacing = result === "offline" ? "offline" : undefined;
        update();
      });
  };
  const stops = [
    options.gate.subscribe(update),
    ...(options.association ? [options.association.subscribe(update)] : []),
    ...(options.judgeAgain ? [options.judgeAgain(update)] : []),
  ];
  update();
  return {
    close() {
      for (const stop of stops) stop();
      void unmount(view);
    },
    retry,
    newKey,
  };
}

/** Why what this browser signs doesn't carry the name, signed in: the
 * line's reason, for the popup of one's own comment; none otherwise. */
export function reasonOf(line: IdentityLine): string | undefined {
  switch (line.kind) {
    case "associate":
      return `${t().identityNotYet} ${t().identityAssociate}.`;
    case "open-here":
      return `${t().identityNotYet} ${t().identityOpenHere}.`;
    case "confirm":
      return `${t().identityNotYet} ${t().identityConfirm}.`;
    case "refused":
      return t().identityRefused;
    case "other":
      return t().identityOther;
    case "unconfirmed":
      return t().identityUnconfirmed;
    default:
      return undefined;
  }
}

/** The chip of the bar (IC5): what is to do —
 * confirm, try again, or, at the home page, the list to associate, to
 * open here, another identity's. Signed out (IC5 precised, 2026-10-30),
 * sign in, once the click opens the window at once; signing in, cancel. */
export type IdentityChip =
  | "new-key"
  | "confirm"
  | "unconfirmed"
  | "associate"
  | "open-here"
  | "other"
  | "sign-in"
  | "pending";

/** What a chip that is a button does, in the click. */
export type IdentityAction =
  | "confirm"
  | "unconfirmed"
  | "sign-in"
  | "pending"
  | "new-key";

export function chipOf(line: IdentityLine): IdentityChip | undefined {
  switch (line.kind) {
    case "sign-in":
      return line.ready ? "sign-in" : undefined;
    case "pending":
    case "confirm":
    case "unconfirmed":
    case "associate":
    case "open-here":
    case "other":
      return line.kind;
    case "refused":
      return "new-key";
    default:
      return undefined;
  }
}

/** Signed in, what the line asks before something is signed (IC4), if anything:
 * the identity to confirm, to try again, or the
 * list to see to at the home page. */
export function notYetOf(line: IdentityLine): NotYet | undefined {
  switch (line.kind) {
    case "confirm":
      return "confirm";
    case "unconfirmed":
      return "unconfirmed";
    case "associate":
    case "open-here":
    case "other":
      return "home";
    default:
      return undefined;
  }
}
