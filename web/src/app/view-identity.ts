import {
  type DocumentSigning,
  formatShortFingerprint,
} from "../../lib/src/index.js";
import type { AttestorState } from "../account/attestor.js";
import { SignToName } from "../account/sign-to-name.js";
import { type Trust, trustIndex } from "../account/trust.js";
import type { DocumentAssociation } from "../keyring/document-association.js";
import { createSignToNameDialog } from "../ui/dialogs/sign-to-name-dialog.js";
import {
  type IdentityAction,
  type IdentityChip,
  chipOf,
  createIdentityLine,
  identityLine,
  notYetOf,
  reasonOf,
} from "../ui/header/identity-line.js";
import type { OwnSignature } from "../view-model/own-signature.svelte.js";
import type { PageMe } from "../view-model/page-me.js";
import type { DocumentTarget } from "./document-view.js";

/** « Continuer sans » answered to decision 20's question on this device. */
export const SIGN_TO_NAME_KEY = "obsidian-collab:sign-to-name";

/** The identity of a document view: the trust of the gateway,
 * the account, the identity line in the menu and the chip in the bar, the
 * question before the first signed object. Started where the view starts,
 * each part as what it needs is read; the view tells it where to show
 * itself as its parts exist. Its interleavings: DV1 – DV5
 * (`docs/phase-38-refactorisation-de-la-page.md`). */
export interface ViewIdentity {
  /** The trust, once read. */
  trust(): Trust | undefined;
  /** Ties `index` to the trust, now or once it is read (DV2). Only while
   * the view opens: what it ties is stopped with the view's `stops`. */
  trusted<T extends Parameters<typeof trustIndex>[1]>(index: T): T;
  /** Decision 20's question, once the account is read (DV5). */
  gate(): SignToName | undefined;
  /** The name signed in, once the account is read; `undefined` before. */
  account(): { name: string | undefined } | undefined;
  /** The identity's section of the menu, once the menu is built. */
  setMenu(section: HTMLElement): void;
  /** The bar's identity chip, once the header is (IC5). */
  setChip(show: (chip: IdentityChip | undefined) => void): void;
  /** What the chip asks, acted on once the identity line is. */
  act(action: IdentityAction): void;
  /** Called again as the account changes, once the document is open. */
  setFollowAuthor(follow: () => void): void;
  /** Signs what the page writes (docs/protocol/06-identity.md), if it has
   * a key. */
  signing(documentId: string): DocumentSigning | undefined;
}

export function followViewIdentity(options: {
  root: HTMLElement;
  target: Pick<
    DocumentTarget,
    "trust" | "association" | "identity" | "apiBase" | "openHome"
  >;
  storage: Storage | undefined;
  own: OwnSignature;
  me: PageMe;
  followKeys(): Promise<void>;
  /** The view's, run as it closes; and whether it has. */
  stops: (() => void)[];
  closed(): boolean;
}): ViewIdentity {
  const { root, target, own, me, followKeys, stops } = options;
  /** The trust, once read; what it is applied to, as they open. */
  let trust: Trust | undefined;
  const trusting: Parameters<typeof trustIndex>[1][] = [];
  /** Decision 20's question, once this page can sign in. */
  let gate: SignToName | undefined;
  // Signed in, the identity's name rather than the pseudonym:
  // shown again (`followAuthor`) once the document is open.
  let identityName: string | undefined;
  let accountRead = false;
  let followAuthor = () => {};
  /** The identity's section of the menu, once the menu is built: the
   * trust may be read before. */
  let markMenu: (section: HTMLElement) => void = () => {};
  /** The bar's identity chip (IC5): shown once the header
   * is, acted on once the identity line is. */
  let showIdentity: (chip: IdentityChip | undefined) => void = () => {};
  let identityAction: (action: IdentityAction) => void = () => {};
  const menu = new Promise<HTMLElement>((resolve) => {
    markMenu = resolve;
  });
  void target.trust?.then((read) => {
    if (!read || options.closed()) {
      read?.close();
      return;
    }
    trust = read;
    stops.push(() => read.close());
    for (const index of trusting) stops.push(trustIndex(read, index));
    void read.account?.then((account) => {
      if (!account || options.closed()) return;
      const storage = options.storage;
      const homeHref = new URL("/", target.apiBase).href;
      /** What the last attestation asked found (IC4). */
      let attestation: AttestorState | undefined;
      /** The association, once read: the line is judged synchronously. */
      let associationNow: DocumentAssociation | undefined;
      void target.association?.then((association) => {
        associationNow = association;
      });
      /** The identity line as it stands, for what is about to be signed. */
      const currentLine = () =>
        identityLine({
          account: account.state(),
          list: associationNow?.situation() ?? { kind: "signed-out" },
          ...(attestation && { attestation }),
        });
      const dialog = createSignToNameDialog(root, () => gate, {
        homeHref,
        ...(target.openHome && { onHome: () => target.openHome?.() }),
        reason: () => reasonOf(currentLine()),
      });
      gate = new SignToName({
        account,
        remembered: () => storage?.getItem(SIGN_TO_NAME_KEY) === "without",
        remember: () => storage?.setItem(SIGN_TO_NAME_KEY, "without"),
        show: (view) => dialog.show(view),
        // The list associated first, if a sign-in just ended.
        attested: async () => {
          await (await target.association)?.settled();
          attestation = await read.refresh();
        },
        // Signed in, why the name isn't carried yet, judged as the
        // identity line judges it (IC4).
        notYet: () => notYetOf(currentLine()),
        retry: async () => {
          await (await target.association)?.retry();
        },
        setTimer: (run, ms) => read.setTimer(run, ms),
      });
      stops.push(() => gate?.close());
      const followAccount = () => {
        const state = account.state();
        // Signing in again (« Confirmer ») keeps the name meanwhile.
        if (state.kind === "pending") return;
        accountRead = true;
        identityName = state.kind === "signed-in" ? state.name : undefined;
        me.setAccount(
          state.kind === "signed-in"
            ? { issuer: state.issuer, sub: state.sub }
            : undefined,
        );
        followAuthor();
      };
      stops.push(account.subscribe(followAccount));
      followAccount();
      // The identity line: the name, or why not yet and what to do.
      void Promise.all([
        target.association ?? Promise.resolve(undefined),
        menu,
      ]).then(([association, identitySection]) => {
        if (options.closed()) return;
        const line = createIdentityLine(identitySection, {
          homeHref,
          ...(target.openHome && { onHome: () => target.openHome?.() }),
          ...(read.orgName && { orgName: read.orgName }),
          gate: account,
          ...(association && { association }),
          attestation: () => read.refresh(),
          judgeAgain: (listener) => read.subscribe(listener),
          // NK6: the refused key replaced, for the account signed in now.
          newKey: async () => {
            const state = account.state();
            const refused = read.refusedKey();
            const identity = target.identity;
            if (
              state.kind !== "signed-in" ||
              !read.gateway ||
              !refused ||
              !identity
            ) {
              return "none";
            }
            return identity.replaceRefused(
              { gateway: read.gateway, issuer: state.issuer, sub: state.sub },
              refused,
            );
          },
          onLine: (line) => {
            own.reason = reasonOf(line);
            // In the bar too (IC5).
            showIdentity(chipOf(line));
            followKeys();
            void target.identity?.signer().then((signer) => {
              own.short = signer
                ? formatShortFingerprint(signer.fingerprint)
                : undefined;
            });
          },
        });
        stops.push(() => line.close());
        // The bar's chip, in the click: a recent sign-in, or again.
        identityAction = (action) => {
          if (action === "confirm") account.start({ recent: true });
          else if (action === "sign-in") account.start();
          else if (action === "pending") account.cancel();
          else if (action === "new-key") line.newKey();
          else line.retry();
        };
      });
    });
  });
  const trusted = <T extends Parameters<typeof trustIndex>[1]>(index: T): T => {
    trusting.push(index);
    if (trust) stops.push(trustIndex(trust, index));
    return index;
  };
  return {
    trust: () => trust,
    trusted,
    gate: () => gate,
    account: () => (accountRead ? { name: identityName } : undefined),
    setMenu: (section) => markMenu(section),
    setChip: (show) => {
      showIdentity = show;
    },
    act: (action) => identityAction(action),
    setFollowAuthor: (follow) => {
      followAuthor = follow;
    },
    signing: (documentId) => {
      const keys = target.identity;
      return (
        keys && {
          documentId,
          signer: () => keys.signer(),
          // The attestation of the key that signed, if held (AT2, ID-38).
          attestation: (publicKey: Uint8Array) => trust?.attestation(publicKey),
          // Decision 20: asked first, once, if this page can sign in.
          beforeSigning: () => gate?.before() ?? Promise.resolve(),
          // What waited for it is dated when signed.
          now: () => Date.now(),
        }
      );
    },
  };
}
