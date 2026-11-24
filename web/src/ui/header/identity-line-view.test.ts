// @vitest-environment jsdom
// The identity line, mounted (analysis 18o.2): the list or the
// attestation not known — the gateway out of reach — is said, and
// « Réessayer » decides the list again and asks the attestation again.
import { describe, expect, test } from "vitest";
import type { AttestorState } from "../../account/attestor.js";
import type { AccountState } from "../../account/sign-in.js";
import type { DocumentSituation } from "../../keyring/document-association.js";
import { createIdentityLine } from "./identity-line.js";

const ada: AccountState = {
  kind: "signed-in",
  name: "Ada Lovelace",
  email: null,
  issuer: "https://idp.example",
  sub: "u-1",
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the identity line, mounted", () => {
  test("not confirmed: said; « Try again » decides and asks again", async () => {
    const container = document.createElement("div");
    let list: DocumentSituation = { kind: "unknown" };
    let attestation: AttestorState = "unattested";
    const listeners = new Set<() => void>();
    const asked: string[] = [];
    createIdentityLine(container, {
      homeHref: "/",
      gate: {
        state: () => ada,
        start: () => {},
        cancel: () => {},
        subscribe: () => () => {},
      },
      association: {
        situation: () => list,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        retry: async () => {
          asked.push("retry");
          list = { kind: "associated" };
          for (const listener of listeners) listener();
        },
      },
      attestation: async () => {
        asked.push("attestation");
        return attestation;
      },
    });
    await settle();
    expect(container.textContent).toContain("could not be confirmed");

    attestation = "attested";
    (container.querySelector(".identity-retry") as HTMLButtonElement).click();
    await settle();

    expect(asked).toEqual(["retry", "attestation"]);
    expect(container.textContent).toContain("What you write carries your name");
  });

  // Analysis 18o.3, IC1: « Confirmer votre identité » is a recent sign-in.
  test("« Confirmer votre identité »: a recent sign-in", async () => {
    const container = document.createElement("div");
    const starts: unknown[] = [];
    createIdentityLine(container, {
      homeHref: "/",
      gate: {
        state: () => ada,
        start: (options) => starts.push(options),
        cancel: () => {},
        subscribe: () => () => {},
      },
      association: {
        situation: () => ({ kind: "associated" }),
        subscribe: () => () => {},
        retry: async () => {},
      },
      attestation: async () => "needs-recent",
    });
    await settle();
    (container.querySelector(".identity-confirm") as HTMLButtonElement).click();
    expect(starts).toEqual([{ recent: true }]);
  });

  // Phase 30, NK3: a newer revocation list, or the list's key changed,
  // and the line judges the attestation again, without reloading.
  test("told to judge again: the attestation asked again, the refusal shown", async () => {
    const container = document.createElement("div");
    let attestation: AttestorState = "attested";
    let judgeAgain = () => {};
    let asked = 0;
    createIdentityLine(container, {
      homeHref: "/",
      gate: {
        state: () => ada,
        start: () => {},
        cancel: () => {},
        subscribe: () => () => {},
      },
      association: {
        situation: () => ({ kind: "associated" }),
        subscribe: () => () => {},
        retry: async () => {},
      },
      attestation: async () => {
        asked += 1;
        return attestation;
      },
      judgeAgain: (listener) => {
        judgeAgain = listener;
        return () => {};
      },
    });
    await settle();
    expect(container.textContent).toContain("What you write carries your name");
    attestation = "refused";
    judgeAgain();
    await settle();
    expect(asked).toBe(2);
    expect(container.querySelector(".identity-reason")?.textContent).toBe(
      "Your organisation no longer attests this browser's key: what you write doesn't carry your name.",
    );
  });

  // Phase 30, NK6: « Nouvelle clé de signature », in the click — the
  // recent sign-in opened if the token isn't recent, the key replaced at
  // the same time, then the attestation asked again.
  test("NK6: « New signing key »: recent sign-in opened, key replaced, attestation asked again", async () => {
    const container = document.createElement("div");
    let attestation: AttestorState = "refused";
    const starts: unknown[] = [];
    let replaced = 0;
    let finish: (result: "drawn" | "offline") => void = () => {};
    let recent = false;
    createIdentityLine(container, {
      homeHref: "/",
      gate: {
        state: () => ada,
        start: (options) => starts.push(options),
        cancel: () => {},
        subscribe: () => () => {},
        recent: () => recent,
      },
      association: {
        situation: () => ({ kind: "associated" }),
        subscribe: () => () => {},
        retry: async () => {},
      },
      attestation: async () => attestation,
      newKey: () => {
        replaced += 1;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    await settle();
    const button = () =>
      container.querySelector(".identity-new-key") as HTMLButtonElement | null;
    expect(button()?.textContent).toBe("New signing key");
    expect(container.textContent).toContain(
      "What you write next will carry your name again.",
    );
    button()?.click();
    expect(starts).toEqual([{ recent: true }]);
    expect(replaced).toBe(1);
    await settle();
    // Under way: once only.
    expect(button()?.disabled).toBe(true);
    button()?.click();
    expect(replaced).toBe(1);
    // Offline: said, the button back.
    finish("offline");
    await settle();
    expect(container.textContent).toContain("Offline: your list couldn't sync");
    expect(button()?.disabled).toBe(false);
    // Recent already: no window; replaced, then attested.
    recent = true;
    button()?.click();
    expect(starts).toHaveLength(1);
    attestation = "attested";
    finish("drawn");
    await settle();
    expect(container.textContent).toContain("What you write carries your name");
  });
});
