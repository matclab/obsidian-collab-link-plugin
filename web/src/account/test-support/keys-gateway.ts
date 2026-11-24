import { sha256 } from "../../../lib/src/annotations/sha256.js";
import { signBytes, verifyBytes } from "../../../lib/src/identity/keys.js";
/** A gateway of keys and attestations, in memory (docs/protocol/
 * 06-identity.md, ID-28 – ID-30): an account's key registered from a
 * recent token with its proof (GW7), a replaced key revoked (GW1), real
 * attestations signed by its own Ed25519 key. Tests only. */
import {
  type Signer,
  encodeCanonical,
  generateIdentityKey,
  signerOf,
} from "../../../lib/src/index.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
export const DAY_S = 24 * 3600;

export interface GatewayAccount {
  issuer: string;
  sub: string;
  key?: Uint8Array;
}

export class KeysGateway {
  readonly accounts = new Map<string, GatewayAccount>();
  /** By token: its account's `sub`, and until when it is recent (ms, the
   * gateway's clock). */
  readonly tokens = new Map<string, { sub: string; recentUntil: number }>();
  readonly revoked = new Set<string>();
  /** Every path asked, in order. */
  readonly asked: string[] = [];
  /** The gateway's clock, in milliseconds. */
  now = 1_800_000_000_000;

  private constructor(readonly key: Signer) {}

  static async create(): Promise<KeysGateway> {
    return new KeysGateway(await signerOf(await generateIdentityKey()));
  }

  get fingerprint(): string {
    return hex(sha256(this.key.publicKey));
  }

  token(token: string, sub: string, recent: boolean): void {
    if (!this.accounts.has(sub)) {
      this.accounts.set(sub, { issuer: "https://idp.example", sub });
    }
    this.tokens.set(token, {
      sub,
      recentUntil: recent ? this.now + 600_000 : 0,
    });
  }

  /** The body of `GET /revocations` (ID-32, ID-35): every key revoked,
   * by fingerprint, signed by this gateway. */
  async revocationsBody(): Promise<string> {
    const at = Math.floor(this.now / 1000);
    const revoked: Record<string, number> = {};
    for (const key of this.revoked) {
      revoked[hex(sha256(Uint8Array.from(Buffer.from(key, "hex"))))] = at;
    }
    const msg = encodeCanonical({
      ctx: "oc-revocations/v1",
      issuedAt: at,
      revoked,
    });
    const list = encodeCanonical({
      key: this.key.publicKey,
      msg,
      sig: await signBytes(this.key.privateKey, msg),
    });
    return JSON.stringify({ issuedAt: at, list: b64url(list) });
  }

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const { pathname } = new URL(url);
    this.asked.push(pathname);
    const bearer = new Headers(init?.headers)
      .get("authorization")
      ?.replace(/^Bearer /, "");
    const held = bearer === undefined ? undefined : this.tokens.get(bearer);
    if (!held) return new Response(null, { status: 401 });
    const account = this.accounts.get(held.sub) as GatewayAccount;
    if (pathname === "/accounts/me") {
      return Response.json({
        name: account.sub,
        email: null,
        expires_at: 1,
        issuer: account.issuer,
        sub: account.sub,
        key: account.key ? b64url(account.key) : null,
      });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<
      string,
      string
    >;
    const key = Uint8Array.from(Buffer.from(body.key ?? "", "base64url"));
    if (pathname === "/accounts/key") {
      if (this.now >= held.recentUntil)
        return new Response(null, { status: 403 });
      const proof = Uint8Array.from(Buffer.from(body.proof ?? "", "base64url"));
      const message = encodeCanonical({
        ctx: "oc-key-proof/v1",
        issuer: account.issuer,
        sub: account.sub,
        key,
      });
      if (!(await verifyBytes(key, proof, message))) {
        return new Response(null, { status: 400 });
      }
      const taken = [...this.accounts.values()].some(
        (other) =>
          other !== account && other.key && hex(other.key) === hex(key),
      );
      if (this.revoked.has(hex(key)) || taken) {
        return new Response(null, { status: 409 });
      }
      if (account.key && hex(account.key) !== hex(key)) {
        this.revoked.add(hex(account.key));
      }
      account.key = key;
      return new Response(null, { status: 204 });
    }
    if (pathname === "/accounts/attestation") {
      if (!account.key || hex(account.key) !== hex(key)) {
        return new Response(null, { status: 409 });
      }
      const issuedAt = Math.floor(this.now / 1000);
      const msg = encodeCanonical({
        ctx: "oc-attestation/v1",
        issuer: account.issuer,
        sub: account.sub,
        name: account.sub,
        key,
        issuedAt,
        expiresAt: issuedAt + 30 * DAY_S,
      });
      const envelope = encodeCanonical({
        key: this.key.publicKey,
        msg,
        sig: await signBytes(this.key.privateKey, msg),
      });
      return Response.json({ attestation: b64url(envelope) });
    }
    return new Response(null, { status: 404 });
  };
}
