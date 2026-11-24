// A keyring server in memory, as `fetch` sees it (docs/protocol/05-keyring.md,
// KR-4 – KR-10), with deposits that add a device (KR-31 – KR-33) and a
// clock of its own: for the page's tests. Tests only.
import {
  base64UrlToBytes,
  bytesToBase64Url,
} from "../../crypto/role-secrets.js";
import { keyringVerifier } from "../crypto.js";

interface Kept {
  verifier: string;
  version: number;
  blob: Uint8Array;
}

interface Deposit {
  keyringId: string;
  blob: Uint8Array;
  expiresAt: number;
}

export class FakeKeyringServer {
  readonly keyrings = new Map<string, Kept>();
  readonly deposits = new Map<string, Deposit>();
  offline = false;
  /** The server's clock, in seconds: the test moves it (KR-32). */
  now = 0;
  private next = 1;

  /** Forgets a keyring, as an administrator would (cas 12). */
  delete(keyringId: string): void {
    this.keyrings.delete(keyringId);
    for (const [id, deposit] of this.deposits) {
      if (deposit.keyringId === keyringId) this.deposits.delete(id);
    }
  }

  fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    if (this.offline) throw new TypeError("offline");
    const path = new URL(url).pathname;
    const headers = new Headers(init.headers);
    const method = init.method ?? "GET";
    if (path === "/keyrings" && method === "POST") {
      const { verifier } = JSON.parse(String(init.body)) as {
        verifier: string;
      };
      const id = (this.next++).toString(16).padStart(32, "0");
      this.keyrings.set(id, { verifier, version: 0, blob: new Uint8Array(0) });
      return Response.json({ keyring_id: id }, { headers: { etag: '"0"' } });
    }
    const take = /^\/pairings\/([^/]*)\/take$/.exec(path);
    if (take && method === "POST") {
      const deposit = this.deposits.get(take[1] ?? "");
      this.deposits.delete(take[1] ?? "");
      if (!deposit || deposit.expiresAt <= this.now)
        return new Response(null, { status: 404 });
      return new Response(deposit.blob.slice() as BodyInit);
    }
    const pairings = /^\/keyrings\/([^/]*)\/pairings$/.exec(path);
    const id = pairings
      ? (pairings[1] ?? "")
      : path.replace(/^\/keyrings\//, "");
    const kept = this.keyrings.get(id);
    const secret = headers.get("keyring-secret");
    if (!kept || !secret) return new Response(null, { status: 404 });
    let opens = false;
    try {
      opens =
        bytesToBase64Url(await keyringVerifier(base64UrlToBytes(secret))) ===
        kept.verifier;
    } catch {}
    if (!opens) return new Response(null, { status: 404 });
    if (pairings && method === "POST") {
      const live = [...this.deposits.values()].filter(
        (d) => d.keyringId === id && d.expiresAt > this.now,
      );
      if (live.length >= 8) return new Response(null, { status: 429 });
      const pairingId = (this.next++).toString(16).padStart(32, "f");
      this.deposits.set(pairingId, {
        keyringId: id,
        blob: new Uint8Array(init.body as Uint8Array),
        expiresAt: this.now + 300,
      });
      return Response.json({ pairing_id: pairingId });
    }
    const tag = (v: number) => ({ etag: `"${v}"` });
    if (method === "GET")
      return new Response(kept.blob.slice() as BodyInit, {
        headers: tag(kept.version),
      });
    if (method === "DELETE") {
      this.delete(id);
      return new Response(null, { status: 204 });
    }
    if (headers.get("if-match") !== `"${kept.version}"`) {
      return new Response(null, { status: 412, headers: tag(kept.version) });
    }
    kept.version += 1;
    kept.blob = new Uint8Array(init.body as Uint8Array);
    return new Response(null, { status: 204, headers: tag(kept.version) });
  };
}
