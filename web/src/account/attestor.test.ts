// The attestation of this device's key (analysis 18k, « Obtenir
// l'attestation »): registered from a recent token then attested; asked a
// recent sign-in otherwise; not asked while one is valid for more than 7
// days, then renewed; given only for its key (AT2); a token refused keeps
// what was obtained (case 3); none without the account's keyring key.
import { describe, expect, test } from "vitest";
import {
  type RevocationList,
  type Signer,
  fingerprintOf,
  generateIdentityKey,
  signerOf,
} from "../../lib/src/index.js";
import { Attestor, RENEW_BEFORE_MS } from "./attestor.js";
import { memoryAccountLocal } from "./test-support.js";
import { DAY_S, KeysGateway } from "./test-support/keys-gateway.js";

const GATEWAY = "https://accounts.example";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

async function setUp(options: { recent: boolean }) {
  const gateway = await KeysGateway.create();
  const local = memoryAccountLocal();
  const signer = await signerOf(await generateIdentityKey());
  gateway.token("T1", "u-1", options.recent);
  // The device's clock is the gateway's, here.
  local.stored = {
    gateway: GATEWAY,
    token: "T1",
    deadline: gateway.now + 12 * 3600_000,
    ...(options.recent && { recentUntil: gateway.now + 600_000 }),
    name: "u-1",
    email: null,
    issuer: "https://idp.example",
    sub: "u-1",
  };
  const timers: { at: number; run: () => void }[] = [];
  let key: Signer | undefined = signer;
  const calls: string[] = [];
  let list: RevocationList | undefined;
  const revocations = { current: () => list, subscribe: () => () => {} };
  const attestor = await Attestor.open({
    gateway: GATEWAY,
    configured: new Set([gateway.fingerprint]),
    local,
    revocations,
    fetch: (url, init) => {
      calls.push(new URL(url).pathname);
      return gateway.fetch(url, init);
    },
    now: () => gateway.now,
    setTimer: (run, ms) => {
      const timer = { at: gateway.now + ms, run };
      timers.push(timer);
      return () => {
        timers.splice(timers.indexOf(timer), 1);
      };
    },
    accountSigner: async () => key,
  });
  return {
    gateway,
    local,
    signer,
    attestor,
    calls,
    timers,
    setKey: (next: Signer | undefined) => {
      key = next;
    },
    /** The page's revocation list now revokes `publicKey` (ID-40). */
    revoke: (publicKey: Uint8Array) => {
      const revoked = new Map(list?.revoked);
      revoked.set(
        hex(fingerprintOf(publicKey)),
        Math.floor(gateway.now / 1000),
      );
      list = { issuedAt: (list?.issuedAt ?? 0) + 1, revoked };
    },
    revocations,
    /** Another Attestor of this device (a new tab), on the same records. */
    reopen: (signer: Signer) =>
      Attestor.open({
        gateway: GATEWAY,
        configured: new Set([gateway.fingerprint]),
        local,
        revocations,
        fetch: (url, init) => {
          calls.push(new URL(url).pathname);
          return gateway.fetch(url, init);
        },
        now: () => gateway.now,
        setTimer: () => () => {},
        accountSigner: async () => signer,
      }),
  };
}

/** The token signed in, ordinary now (a sign-in of today, not recent). */
function ordinary(s: Awaited<ReturnType<typeof setUp>>) {
  s.gateway.token("T1", "u-1", false);
  if (s.local.stored) {
    const { recentUntil: _, ...rest } = s.local.stored;
    s.local.stored = rest;
  }
}

describe("the attestation of this device's key", () => {
  test("from a recent token: registered, then attested", async () => {
    const s = await setUp({ recent: true });
    expect(s.attestor.wantsRecent()).toBe(true);
    expect(await s.attestor.refresh()).toBe("attested");
    expect(s.calls).toEqual([
      "/accounts/attestation",
      "/accounts/key",
      "/accounts/attestation",
    ]);
    expect(s.attestor.envelopeFor(s.signer.publicKey)).toBeInstanceOf(
      Uint8Array,
    );
    expect(s.attestor.wantsRecent()).toBe(false);
    expect(s.local.kept?.sub).toBe("u-1");
  });

  test("from an ordinary token, a key not registered: a recent sign-in asked", async () => {
    const s = await setUp({ recent: false });
    expect(await s.attestor.refresh()).toBe("needs-recent");
    expect(s.calls).toEqual(["/accounts/attestation"]);
    expect(s.gateway.accounts.get("u-1")?.key).toBeUndefined();
  });

  // Analysis 18o.3, IC1: an attestation held for another key (the list
  // before) doesn't make the next sign-in ordinary.
  test("IC1: needs-recent for the key of the moment: a recent sign-in wanted, another key's attestation held", async () => {
    const s = await setUp({ recent: true });
    await s.attestor.refresh();
    expect(s.attestor.wantsRecent()).toBe(false);
    s.setKey(await signerOf(await generateIdentityKey()));
    s.gateway.token("T1", "u-1", false);
    if (s.local.stored) {
      const { recentUntil: _, ...ordinary } = s.local.stored;
      s.local.stored = ordinary;
    }
    expect(await s.attestor.refresh()).toBe("needs-recent");
    expect(s.attestor.wantsRecent()).toBe(true);
  });

  test("valid for more than 7 days: nothing asked; then renewed by its timer", async () => {
    const s = await setUp({ recent: true });
    await s.attestor.refresh();
    s.calls.length = 0;
    expect(await s.attestor.refresh()).toBe("attested");
    expect(s.calls).toEqual([]);
    const timer = s.timers.at(-1);
    expect(timer?.at).toBe(s.gateway.now + 30 * DAY_S * 1000 - RENEW_BEFORE_MS);
    // An ordinary token renews a registered key.
    s.gateway.token("T1", "u-1", false);
    s.gateway.now = timer?.at as number;
    // Signed in again since: a token of today, not recent.
    if (s.local.stored) {
      s.local.stored = {
        ...s.local.stored,
        deadline: s.gateway.now + 3600_000,
        recentUntil: 0,
      };
    }
    const before = s.attestor.envelopeFor(s.signer.publicKey);
    timer?.run();
    await s.attestor.refreshing();
    expect(s.calls).toEqual(["/accounts/attestation"]);
    expect(s.attestor.envelopeFor(s.signer.publicKey)).not.toEqual(before);
  });

  test("AT2: given for its key only, and only while valid", async () => {
    const s = await setUp({ recent: true });
    await s.attestor.refresh();
    const other = await signerOf(await generateIdentityKey());
    expect(s.attestor.envelopeFor(other.publicKey)).toBeUndefined();
    s.gateway.now += 30 * DAY_S * 1000;
    expect(s.attestor.envelopeFor(s.signer.publicKey)).toBeUndefined();
  });

  test("case 3: a token refused keeps what was obtained", async () => {
    const s = await setUp({ recent: true });
    await s.attestor.refresh();
    s.gateway.tokens.clear();
    s.gateway.now += 25 * DAY_S * 1000;
    expect(await s.attestor.refresh()).toBe("unattested");
    expect(s.attestor.envelopeFor(s.signer.publicKey)).toBeInstanceOf(
      Uint8Array,
    );
  });

  test("SG2: no key of the account's keyring, nothing asked", async () => {
    const s = await setUp({ recent: true });
    s.setKey(undefined);
    expect(await s.attestor.refresh()).toBe("unattested");
    expect(s.calls).toEqual([]);
  });

  test("an attestation kept on the device is read at opening", async () => {
    const s = await setUp({ recent: true });
    await s.attestor.refresh();
    const reopened = await Attestor.open({
      gateway: GATEWAY,
      configured: new Set([s.gateway.fingerprint]),
      local: s.local,
      fetch: s.gateway.fetch,
      now: () => s.gateway.now,
      setTimer: () => () => {},
      accountSigner: async () => s.signer,
    });
    expect(reopened.envelopeFor(s.signer.publicKey)).toEqual(
      s.attestor.envelopeFor(s.signer.publicKey),
    );
    // Configured no more: not given.
    const distrusting = await Attestor.open({
      gateway: GATEWAY,
      configured: new Set(["ab".repeat(32)]),
      local: s.local,
      fetch: s.gateway.fetch,
      now: () => s.gateway.now,
      setTimer: () => () => {},
      accountSigner: async () => s.signer,
    });
    expect(distrusting.envelopeFor(s.signer.publicKey)).toBeUndefined();
  });

  // Found by the end to end test of 18o.2: a sign-in asks for the
  // attestation at once, before the list is the identity's; asked again
  // once it is, the answer must not be that first run's.
  test("asked again while a run goes on: a run after it, not its answer", async () => {
    const s = await setUp({ recent: true });
    // The first run reads the key while the list isn't the identity's.
    let readFirst = () => {};
    const firstRead = new Promise<void>((resolve) => {
      readFirst = resolve;
    });
    let reads = 0;
    const attestor = await Attestor.open({
      gateway: GATEWAY,
      configured: new Set([s.gateway.fingerprint]),
      local: s.local,
      fetch: (url, init) => s.gateway.fetch(url, init),
      now: () => s.gateway.now,
      setTimer: () => () => {},
      accountSigner: async () => {
        reads += 1;
        if (reads === 1) {
          readFirst();
          return undefined;
        }
        return s.signer;
      },
    });
    const first = attestor.refresh();
    await firstRead;
    const second = attestor.refresh();

    expect(await first).toBe("unattested");
    expect(await second).toBe("attested");
    expect(attestor.envelopeFor(s.signer.publicKey)).toBeInstanceOf(Uint8Array);
  });
});

// Phase 30, NK1 – NK2 (ADR-0056 §1): a key that can't be attested for the
// account any more is said refused — by the page's revocation list, or by
// a 409 at registration, kept on the device — without asking the gateway.
describe("a refused key (phase 30, NK1, NK2)", () => {
  test("NK2: revoked by the list, an attestation held: refused, nothing asked", async () => {
    const s = await setUp({ recent: true });
    expect(await s.attestor.refresh()).toBe("attested");
    s.calls.length = 0;
    s.revoke(s.signer.publicKey);
    expect(await s.attestor.refresh()).toBe("refused");
    expect(s.calls).toEqual([]);
    expect(s.attestor.refusedKey()).toEqual(s.signer.publicKey);
    // Still joined to what it signs (ID-38): readers judge it by its date.
    expect(s.attestor.envelopeFor(s.signer.publicKey)).toBeInstanceOf(
      Uint8Array,
    );
  });

  test("NK2: revoked by the list, none held: refused, nothing asked", async () => {
    const s = await setUp({ recent: true });
    s.revoke(s.signer.publicKey);
    expect(await s.attestor.refresh()).toBe("refused");
    expect(s.calls).toEqual([]);
    expect(s.attestor.wantsRecent()).toBe(false);
  });

  test("NK2: another key revoked: attested as before", async () => {
    const s = await setUp({ recent: true });
    s.revoke((await signerOf(await generateIdentityKey())).publicKey);
    expect(await s.attestor.refresh()).toBe("attested");
    expect(s.attestor.refusedKey()).toBeUndefined();
  });

  test("NK1: refused at registration (another account's key): kept on the device, a new tab asks nothing", async () => {
    const s = await setUp({ recent: true });
    s.gateway.token("T2", "u-2", true);
    s.gateway.accounts.set("u-2", {
      issuer: "https://idp.example",
      sub: "u-2",
      key: s.signer.publicKey,
    });
    expect(await s.attestor.refresh()).toBe("refused");
    expect(s.attestor.refusedKey()).toEqual(s.signer.publicKey);
    // Not in the revocation list: only the device remembers it.
    ordinary(s);
    s.calls.length = 0;
    const tab = await s.reopen(s.signer);
    expect(await tab.refresh()).toBe("refused");
    expect(s.calls).toEqual([]);
    expect(tab.refusedKey()).toEqual(s.signer.publicKey);
  });

  test("NK1: a 409 at the attestation alone keeps nothing", async () => {
    const s = await setUp({ recent: false });
    expect(await s.attestor.refresh()).toBe("needs-recent");
    const tab = await s.reopen(s.signer);
    expect(await tab.refresh()).toBe("needs-recent");
    expect(tab.refusedKey()).toBeUndefined();
  });

  test("NK1: a refusal kept for another key, or another account, has no effect", async () => {
    const s = await setUp({ recent: true });
    const other = await signerOf(await generateIdentityKey());
    await s.local.keepRefusedKey({
      gateway: GATEWAY,
      issuer: "https://idp.example",
      sub: "u-1",
      key: other.publicKey,
    });
    expect(await (await s.reopen(s.signer)).refresh()).toBe("attested");
    await s.local.keepRefusedKey({
      gateway: GATEWAY,
      issuer: "https://idp.example",
      sub: "u-2",
      key: s.signer.publicKey,
    });
    expect(await (await s.reopen(s.signer)).refresh()).toBe("attested");
  });

  test("NK1: the list's key replaced, the refusal is for the old one only", async () => {
    const s = await setUp({ recent: true });
    s.revoke(s.signer.publicKey);
    expect(await s.attestor.refresh()).toBe("refused");
    const next = await signerOf(await generateIdentityKey());
    s.setKey(next);
    expect(await s.attestor.refresh()).toBe("attested");
    expect(s.attestor.refusedKey()).toBeUndefined();
    expect(s.gateway.accounts.get("u-1")?.key).toEqual(next.publicKey);
  });
});

// Phase 30, NK5 (ADR-0056 §4): the key registered only from the list as
// the page synced it just before.
describe("the key registered only once synced (phase 30, NK5)", () => {
  const open = async (registrable: () => Promise<boolean>) => {
    const s = await setUp({ recent: true });
    s.calls.length = 0;
    const attestor = await Attestor.open({
      gateway: GATEWAY,
      configured: new Set([s.gateway.fingerprint]),
      local: s.local,
      fetch: (url, init) => {
        s.calls.push(new URL(url).pathname);
        return s.gateway.fetch(url, init);
      },
      now: () => s.gateway.now,
      setTimer: () => () => {},
      accountSigner: async () => s.signer,
      registrable,
    });
    return { s, attestor };
  };

  test("not synced, or no more the list's key: nothing registered", async () => {
    const { s, attestor } = await open(async () => false);
    expect(await attestor.refresh()).toBe("unattested");
    expect(s.calls).toEqual(["/accounts/attestation"]);
    expect(s.gateway.accounts.get("u-1")?.key).toBeUndefined();
  });

  test("synced, the list's key: registered, then attested", async () => {
    const { s, attestor } = await open(async () => true);
    expect(await attestor.refresh()).toBe("attested");
    expect(s.gateway.accounts.get("u-1")?.key).toEqual(s.signer.publicKey);
  });
});
