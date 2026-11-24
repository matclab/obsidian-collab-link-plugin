/** Doubles for signing in: a gateway that answers what
 * the test says, when it says; channels between tabs that deliver when
 * the test says; the account record in memory. */
import { type SignInAttempt, challengeOf } from "../../lib/src/index.js";
import type {
  AccountLocal,
  KeptAttestation,
  RefusedKey,
  SignedIn,
} from "../keyring/local.js";
import type { AccountChannel } from "./sign-in.js";

/** BroadcastChannel's semantics: a message reaches every other channel of
 * its name, never the one that sent it, when `deliver` is called. */
export class ChannelBus {
  private listeners: {
    name: string;
    from: object;
    listener: (data: unknown) => void;
  }[] = [];
  readonly queue: { name: string; data: unknown; from?: object }[] = [];

  channel(name: string): AccountChannel {
    const from = {};
    return {
      post: (data) => this.queue.push({ name, data, from }),
      listen: (listener) => {
        const entry = { name, from, listener };
        this.listeners.push(entry);
        return () => {
          this.listeners = this.listeners.filter((e) => e !== entry);
        };
      },
    };
  }

  /** A message posted by a page that is no tab here (`/auth-return`, or
   * any page of the origin). */
  postFromElsewhere(name: string, data: unknown): void {
    this.queue.push({ name, data });
  }

  /** Delivers the message at `index` of the queue. */
  deliver(index = 0): void {
    const [message] = this.queue.splice(index, 1);
    if (!message) return;
    for (const { name, from, listener } of [...this.listeners]) {
      if (name === message.name && from !== message.from)
        listener(message.data);
    }
  }

  deliverAll(): void {
    while (this.queue.length > 0) this.deliver();
  }
}

/** The account record, shared by the tabs of a device. */
export function memoryAccountLocal(): AccountLocal & {
  stored: SignedIn | undefined;
  kept: KeptAttestation | undefined;
  refused: RefusedKey | undefined;
} {
  const local = {
    stored: undefined as SignedIn | undefined,
    kept: undefined as KeptAttestation | undefined,
    refused: undefined as RefusedKey | undefined,
    async refusedKey() {
      return local.refused && { ...local.refused };
    },
    async keepRefusedKey(refused: RefusedKey) {
      local.refused = { ...refused };
    },
    async attestation() {
      return local.kept && { ...local.kept };
    },
    async keepAttestation(kept: KeptAttestation) {
      local.kept = { ...kept };
    },
    async signedIn() {
      return local.stored && { ...local.stored };
    },
    async keepSignedIn(account: SignedIn) {
      local.stored = { ...account };
    },
    async forgetSignedIn(token: string) {
      if (local.stored?.token === token) local.stored = undefined;
    },
    async associationLater() {
      return false;
    },
    async keepAssociationLater() {},
    async identityName() {
      return undefined;
    },
    async keepIdentityName() {},
  };
  return local;
}

/** Answers of the gateway, by path. */
export interface GatewayCall {
  path: string;
  init?: RequestInit;
  answer(response: Response): void;
  fail(): void;
}

/** A gateway whose answers wait for the test. */
export class PendingGateway {
  readonly calls: GatewayCall[] = [];

  fetch = (url: string, init?: RequestInit): Promise<Response> =>
    new Promise((resolve, reject) => {
      this.calls.push({
        path: new URL(url).pathname,
        ...(init && { init }),
        answer: resolve,
        fail: () => reject(new TypeError("network")),
      });
    });

  take(path: string): GatewayCall {
    const index = this.calls.findIndex((call) => call.path === path);
    if (index < 0) throw new Error(`no call to ${path}`);
    return this.calls.splice(index, 1)[0] as GatewayCall;
  }
}

let next = 0;

/** Attempts with known, distinct values. */
export async function knownAttempt(): Promise<SignInAttempt> {
  next += 1;
  const verifier = btoa(String.fromCharCode(...new Uint8Array(32).fill(next)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return {
    request: next.toString(16).padStart(32, "0"),
    verifier,
    challenge: await challengeOf(verifier),
  };
}

/** A code of the gateway's form: 32 bytes in base64url. */
export function codeOf(n: number): string {
  return btoa(String.fromCharCode(...new Uint8Array(32).fill(n)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function sessionAnswer(token: string, sub = "u-1"): Response {
  return new Response(
    JSON.stringify({
      token,
      expires_at: 1,
      name: "Ada",
      email: "ada@example.org",
      issuer: "https://idp.example",
      sub,
    }),
    { status: 200 },
  );
}

/** The request of the window's address. */
export function requestOf(address: string): string {
  return new URL(address).searchParams.get("request") ?? "";
}

/** A gateway in memory (docs/protocol/05-keyring.md, §5.12): each
 * account's keyring and deposits, opened by its token (KR-39 – KR-41). */
export class FakeGateway {
  readonly keyrings = new Map<string, { version: number; blob: Uint8Array }>();
  readonly deposits = new Map<string, { sub: string; blob: Uint8Array }>();
  /** By token: its account's `sub`. */
  readonly tokens = new Map<string, string>();
  /** Every request to an account's keyring: the account it was for. */
  readonly asked: { path: string; sub: string | undefined }[] = [];
  private next = 0;

  constructor(readonly origin = "https://accounts.example") {}

  /** A token of `sub`'s account. */
  tokenOf(sub: string): string {
    this.next += 1;
    const token = codeOf(100 + this.next);
    this.tokens.set(token, sub);
    return token;
  }

  /** What `sub`'s keyring holds: its version and blob. */
  keyringOf(sub: string): { version: number; blob: Uint8Array } {
    return this.keyrings.get(sub) ?? { version: 0, blob: new Uint8Array() };
  }

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const { pathname } = new URL(url);
    const headers = new Headers(init?.headers);
    const bearer = headers.get("authorization")?.replace(/^Bearer /, "");
    const sub = bearer === undefined ? undefined : this.tokens.get(bearer);
    if (pathname === "/accounts/health") return new Response("{}");
    if (pathname === "/accounts/logout") {
      if (bearer) this.tokens.delete(bearer);
      return new Response(null, { status: 204 });
    }
    this.asked.push({ path: pathname, sub });
    if (sub === undefined) return new Response(null, { status: 401 });
    const body = async () =>
      new Uint8Array(await new Response(init?.body ?? null).arrayBuffer());
    if (pathname === "/accounts/keyring") {
      const stored = this.keyringOf(sub);
      if ((init?.method ?? "GET") === "GET") {
        return new Response(stored.blob as BodyInit, {
          headers: { etag: `"${stored.version}"` },
        });
      }
      if (headers.get("if-match") !== `"${stored.version}"`) {
        return new Response(null, {
          status: 412,
          headers: { etag: `"${stored.version}"` },
        });
      }
      const version = stored.version + 1;
      this.keyrings.set(sub, { version, blob: await body() });
      return new Response(null, {
        status: 204,
        headers: { etag: `"${version}"` },
      });
    }
    if (pathname === "/accounts/keyring/pairings") {
      this.next += 1;
      const id = this.next.toString(16).padStart(32, "0");
      this.deposits.set(id, { sub, blob: await body() });
      return new Response(JSON.stringify({ pairing_id: id }));
    }
    const take = /^\/accounts\/pairings\/([0-9a-f]{32})\/take$/.exec(pathname);
    if (take) {
      const deposit = this.deposits.get(take[1] as string);
      if (!deposit || deposit.sub !== sub) {
        return new Response(null, { status: 404 });
      }
      this.deposits.delete(take[1] as string);
      return new Response(deposit.blob as BodyInit);
    }
    return new Response(null, { status: 404 });
  };
}
