// A key registered and attested from a client (docs/protocol/06-identity.md,
// ID-28 – ID-31): the recent sign-in's address, the proof and the bodies
// as the vectors write them (identity.attestation), each answer of the
// gateway read as what it says — and an attestation kept only if it is one
// of a configured key, for the key asked.
import { describe, expect, test } from "vitest";
import { encodeCanonical } from "../identity/cbor.js";
import { importIdentityKey, signBytes } from "../identity/keys.js";
import { signerOf } from "../identity/signature.js";
import { fromHex, vectors } from "../test-support/vectors.js";
import { accountKey, registerKey, requestAttestation } from "./attestation.js";
import { signInAddress } from "./sign-in.js";

const { identity } = vectors;
const v = identity.attestation;
const GATEWAY = "https://accounts.example";
const TOKEN = "t".repeat(43);

const pkcs8 = (seed: string) =>
  fromHex(`302e020100300506032b657004220420${seed}`);
const person = async () =>
  signerOf(
    await importIdentityKey(
      pkcs8(identity.key.seed),
      fromHex(identity.key.public_key),
    ),
  );

/** Records the requests; answers each with `answers` in turn. */
function gatewayAnswering(...answers: Response[]) {
  const sent: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    sent.push({ url, init });
    const next = answers.shift();
    if (!next) throw new Error("no answer");
    return next;
  };
  return { sent, fetchFn };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });
const empty = (status: number) => new Response(null, { status });

describe("ID-28: a recent sign-in", () => {
  test("asks with `fresh`, once and empty", () => {
    const attempt = {
      request: "0".repeat(32),
      verifier: "",
      challenge: "c".repeat(43),
    };
    expect(signInAddress(GATEWAY, attempt, { fresh: true })).toBe(
      `${GATEWAY}/accounts/login?request=${"0".repeat(32)}&challenge=${"c".repeat(43)}&fresh`,
    );
    expect(signInAddress(GATEWAY, attempt)).not.toContain("fresh");
  });
});

describe("ID-28: the account's key", () => {
  test("read from `me`, null when none; 401 is signed out", async () => {
    const { sent, fetchFn } = gatewayAnswering(
      json(200, {
        name: "Ada",
        email: null,
        expires_at: 1,
        issuer: "i",
        sub: "s",
        key: v.key_bodies[0].json.key,
      }),
      json(200, {
        name: "Ada",
        email: null,
        expires_at: 1,
        issuer: "i",
        sub: "s",
        key: null,
      }),
      empty(401),
    );
    expect(await accountKey(GATEWAY, TOKEN, fetchFn)).toEqual(
      fromHex(identity.key.public_key),
    );
    expect(await accountKey(GATEWAY, TOKEN, fetchFn)).toBeNull();
    expect(await accountKey(GATEWAY, TOKEN, fetchFn)).toBe("signed-out");
    expect(sent[0]?.url).toBe(`${GATEWAY}/accounts/me`);
    expect(
      (sent[0]?.init?.headers as Record<string, string>).Authorization,
    ).toBe(`Bearer ${TOKEN}`);
  });

  test("a key not of 32 bytes, or not text, is no answer", async () => {
    for (const key of ["AAAA", 7]) {
      const { fetchFn } = gatewayAnswering(
        json(200, {
          name: "A",
          email: null,
          expires_at: 1,
          issuer: "i",
          sub: "s",
          key,
        }),
      );
      await expect(accountKey(GATEWAY, TOKEN, fetchFn)).rejects.toThrow();
    }
  });
});

describe("ID-29: registering the key", () => {
  test("the proof and the body to the byte, for the account", async () => {
    const proof = v.proofs[0];
    const { sent, fetchFn } = gatewayAnswering(empty(204));
    expect(
      await registerKey(
        GATEWAY,
        TOKEN,
        { issuer: proof.issuer, sub: proof.sub },
        await person(),
        fetchFn,
      ),
    ).toBe("registered");
    expect(sent[0]?.url).toBe(`${GATEWAY}/accounts/key`);
    expect(sent[0]?.init?.method).toBe("PUT");
    expect(JSON.parse(sent[0]?.init?.body as string)).toEqual(
      v.key_bodies[0].json,
    );
  });

  test("each refusal says what it is", async () => {
    const signer = await person();
    for (const [status, outcome] of [
      [401, "signed-out"],
      [403, "not-recent"],
      [409, "refused"],
    ] as const) {
      const { fetchFn } = gatewayAnswering(empty(status));
      expect(
        await registerKey(
          GATEWAY,
          TOKEN,
          { issuer: "i", sub: "s" },
          signer,
          fetchFn,
        ),
      ).toBe(outcome);
    }
    const { fetchFn } = gatewayAnswering(empty(500));
    await expect(
      registerKey(GATEWAY, TOKEN, { issuer: "i", sub: "s" }, signer, fetchFn),
    ).rejects.toThrow();
  });
});

describe("ID-30: asking for an attestation", () => {
  const configured = new Set<string>([v.gateway_key.fingerprint]);
  const key = fromHex(identity.key.public_key);
  const envelope = v.attestations[0].envelope as string;
  const base64url = (hex: string) =>
    Buffer.from(hex, "hex").toString("base64url");

  test("the body; the envelope kept, with its attestation", async () => {
    const { sent, fetchFn } = gatewayAnswering(
      json(200, { attestation: base64url(envelope) }),
    );
    const got = await requestAttestation(
      GATEWAY,
      TOKEN,
      key,
      configured,
      fetchFn,
    );
    expect(sent[0]?.url).toBe(`${GATEWAY}/accounts/attestation`);
    expect(JSON.parse(sent[0]?.init?.body as string)).toEqual(
      v.attestation_bodies[0].json,
    );
    if (typeof got !== "object") throw new Error(String(got));
    expect(Buffer.from(got.envelope).toString("hex")).toBe(envelope);
    expect(got.attestation.name).toBe(v.attestations[0].fields.name);
  });

  test("409 is not the key; 401 signed out", async () => {
    for (const [status, outcome] of [
      [409, "not-the-key"],
      [401, "signed-out"],
    ] as const) {
      const { fetchFn } = gatewayAnswering(empty(status));
      expect(
        await requestAttestation(GATEWAY, TOKEN, key, configured, fetchFn),
      ).toBe(outcome);
    }
  });

  test("an attestation of another key, or of a key not configured, is refused", async () => {
    // Another person's key asked for: the envelope attests ours.
    const other = new Uint8Array(32).fill(7);
    for (const [asked, trusted] of [
      [other, configured],
      [key, new Set<string>(["ab".repeat(32)])],
    ] as const) {
      const { fetchFn } = gatewayAnswering(
        json(200, { attestation: base64url(envelope) }),
      );
      await expect(
        requestAttestation(GATEWAY, TOKEN, asked, trusted, fetchFn),
      ).rejects.toThrow();
    }
    const { fetchFn } = gatewayAnswering(json(200, { attestation: 7 }));
    await expect(
      requestAttestation(GATEWAY, TOKEN, key, configured, fetchFn),
    ).rejects.toThrow();
  });
});

// The proof is Ed25519's, deterministic: the same bytes as the vectors'.
test("the proof signs ID-29's message", async () => {
  const signer = await person();
  const proof = v.proofs[0];
  const message = encodeCanonical({
    ctx: "oc-key-proof/v1",
    issuer: proof.issuer,
    sub: proof.sub,
    key: signer.publicKey,
  });
  expect(Buffer.from(message).toString("hex")).toBe(proof.message);
  expect(
    Buffer.from(await signBytes(signer.privateKey, message)).toString("hex"),
  ).toBe(proof.proof);
});
