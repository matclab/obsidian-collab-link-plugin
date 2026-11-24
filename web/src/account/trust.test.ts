// What a host trusts of its gateway when it doesn't take it from the
// server (docs/phase-18-trousseau-identite.md, analysis 18m, M3, OB3): the
// plugin's settings, given to `openTrust`; `/config.json` is then never
// read, and the revocation list comes from the server it names.
import { describe, expect, test } from "vitest";
import { vectors } from "../../lib/src/test-support/vectors.js";
import type { IdentityKeys } from "../identity/identity-keys.js";
import type { RevocationReader } from "./revocations.js";
import { openTrust } from "./trust.js";

const A = "a".repeat(64);

function recording() {
  const asked: string[] = [];
  return {
    asked,
    fetch: async (url: string) => {
      asked.push(url);
      return new Response(null, { status: 404 });
    },
  };
}

describe("a trust given by its host", () => {
  test("its keys, never /config.json; revocations from its server", async () => {
    const { asked, fetch } = recording();
    const trust = await openTrust({
      apiBase: "https://collab.example.org",
      config: { attestationKeys: [A], orgName: "Systerel" },
      fetch,
      setTimer: () => () => {},
      now: () => 0,
    });
    expect(trust?.attestationKeys).toEqual(new Set([A]));
    expect(trust?.orgName).toBe("Systerel");
    expect(asked).toEqual(["https://collab.example.org/revocations"]);
    trust?.close();
  });

  test("no key given: no trust, and nothing asked", async () => {
    const { asked, fetch } = recording();
    const trust = await openTrust({
      apiBase: "https://collab.example.org",
      config: {},
      fetch,
      setTimer: () => () => {},
      now: () => 0,
    });
    expect(trust).toBeUndefined();
    expect(asked).toEqual([]);
  });
});

// Phase 30, NK3: what shows the attestation's state is told to judge it
// again when a newer revocation list is read, and when the list's key
// changes — not otherwise.
describe("the attestation judged again (phase 30, NK3)", () => {
  const v = vectors.identity.attestations;
  const [list] = v.revocation_bodies as { text: string }[];

  test("told of a newer revocation list, and of the keyring's key changed", async () => {
    let keyChanged = () => {};
    let stopped = false;
    const identity = {
      subscribeKey: async (listener: () => void) => {
        keyChanged = listener;
        return () => {
          stopped = true;
        };
      },
    } as unknown as IdentityKeys;
    let serve = () => {};
    const trust = await openTrust({
      apiBase: "https://collab.example.org",
      config: { attestationKeys: v.configured },
      // Answered once the test listens.
      fetch: () =>
        new Promise<Response>((resolve) => {
          serve = () => resolve(new Response(list?.text, { status: 200 }));
        }),
      setTimer: () => () => {},
      now: () => 0,
      identity,
    });
    let told = 0;
    trust?.subscribe(() => told++);
    expect(told).toBe(0);
    serve();
    await (trust?.revocations as RevocationReader).settled();
    expect(trust?.revocations.current()).toBeDefined();
    expect(told).toBe(1);
    keyChanged();
    expect(told).toBe(2);
    trust?.close();
    await expect.poll(() => stopped).toBe(true);
  });
});
