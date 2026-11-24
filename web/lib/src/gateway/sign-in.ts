/** Signing in with a gateway (docs/protocol/06-identity.md, §6.7): the
 * attempt and its window's address (ID-19), the return the server's page
 * receives (ID-20, ID-25), the exchange of its code for a token (ID-21,
 * ID-24), the end of a token and the gateway's health (ID-22). Without
 * state: the page keeps the attempt in progress. */
import { bytesToBase64Url } from "../crypto/role-secrets.js";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** How long a token is valid (ID-21), on whichever clock. */
export const TOKEN_MS = 12 * 3600 * 1000;

/** One attempt to sign in: `request` names it, `verifier` stays in the
 * tab until the exchange, `challenge` is `SHA-256(verifier)` (ID-19). */
export interface SignInAttempt {
  request: string;
  verifier: string;
  challenge: string;
}

/** What the window brings back (ID-20): a code for the attempt `request`,
 * or its refusal. A reason a client doesn't know is `failed` (ID-25). */
export type SignInReturn =
  | { request: string; code: string }
  | { request: string; error: "denied" | "failed" };

/** A token and its account (ID-21, ID-24). `expiresAt` is the gateway's
 * clock: a client measures validity on its own (ID-25). */
export interface GatewaySession {
  token: string;
  expiresAt: number;
  name: string;
  email: string | null;
  issuer: string;
  sub: string;
}

const REQUEST = /^[0-9a-f]{32}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;

function random(bytes: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(bytes));
}

/** 32 bytes in base64url, as written by its encoder: no other text
 * decodes to the same bytes (the last character's low bits are zero). */
function isSecret(text: string): boolean {
  if (!SECRET.test(text)) return false;
  return "AEIMQUYcgkosw048".includes(text[42] as string);
}

export async function newSignInAttempt(): Promise<SignInAttempt> {
  const request = [...random(16)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const verifier = bytesToBase64Url(random(32));
  return { request, verifier, challenge: await challengeOf(verifier) };
}

/** `SHA-256(v)` in base64url (ID-19), `v` being the verifier's bytes. */
export async function challengeOf(verifier: string): Promise<string> {
  if (!isSecret(verifier)) throw new Error("a verifier is 32 bytes");
  const binary = atob(verifier.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToBase64Url(new Uint8Array(digest));
}

/** The window's address (ID-19); `fresh`, a recent sign-in (ID-28). */
export function signInAddress(
  gateway: string,
  attempt: SignInAttempt,
  options: { fresh?: boolean; client?: "obsidian" } = {},
): string {
  const url = new URL("/accounts/login", gateway);
  const fresh = options.fresh ? "&fresh" : "";
  // ID-41: returned by obsidian://, not by the server's page.
  const client = options.client ? `&client=${options.client}` : "";
  url.search = `request=${attempt.request}&challenge=${attempt.challenge}${fresh}${client}`;
  return url.href;
}

/** The action of the plugin's `obsidian://` handler (ID-41). */
export const OBSIDIAN_RETURN_ACTION = "collab-link-auth";

/** The return by `obsidian://collab-link-auth` (ID-41): the parameters
 * Obsidian hands its handler, decoded, read as the fragment is — beside
 * `action`, nothing else, `hash` included (a query can forge it). */
export function readObsidianReturn(params: unknown): SignInReturn | undefined {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return undefined;
  }
  const { action, ...rest } = params as Record<string, unknown>;
  if (action !== OBSIDIAN_RETURN_ACTION) return undefined;
  return readSignInMessage(rest);
}

/** The return in the fragment of `/auth-return` (ID-20, ID-25): `code` and
 * `request`, or `error` and `request`, each once, nothing else; else
 * `undefined`. */
export function readSignInReturn(hash: string): SignInReturn | undefined {
  if (!hash.startsWith("#")) return undefined;
  const fields = new Map<string, string>();
  for (const part of hash.slice(1).split("&")) {
    const at = part.indexOf("=");
    if (at < 0) return undefined;
    const name = part.slice(0, at);
    if (fields.has(name)) return undefined;
    fields.set(name, part.slice(at + 1));
  }
  return signInReturnOf(Object.fromEntries(fields));
}

/** A return as the page's channel carries it (`{request, code}` or
 * `{request, error}`), checked as the fragment: another page of the
 * origin may write anything there. */
export function readSignInMessage(data: unknown): SignInReturn | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return undefined;
  }
  const fields: Record<string, string> = {};
  for (const [name, value] of Object.entries(data)) {
    if (typeof value !== "string") return undefined;
    fields[name] = value;
  }
  return signInReturnOf(fields);
}

function signInReturnOf(
  fields: Record<string, string>,
): SignInReturn | undefined {
  const names = Object.keys(fields).sort().join(",");
  const { request, code, error } = fields;
  if (request === undefined || !REQUEST.test(request)) return undefined;
  if (names === "code,request" && code !== undefined && isSecret(code)) {
    return { request, code };
  }
  if (names === "error,request" && error !== undefined) {
    if (!/^[a-z_]{1,32}$/.test(error)) return undefined;
    return { request, error: error === "denied" ? "denied" : "failed" };
  }
  return undefined;
}

/** A session answer (ID-21, ID-24), or an `Error`: fields it doesn't know
 * are ignored. */
export function readGatewaySession(value: unknown): GatewaySession {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("a session is a JSON object");
  }
  const { token, expires_at, name, email, issuer, sub } = value as Record<
    string,
    unknown
  >;
  if (typeof token !== "string" || !isSecret(token)) {
    throw new Error("a session has a token");
  }
  if (!Number.isSafeInteger(expires_at) || (expires_at as number) < 0) {
    throw new Error("a session has its expiry");
  }
  if (typeof name !== "string") throw new Error("a session has a name");
  if (email !== null && typeof email !== "string") {
    throw new Error("an address is text or null");
  }
  if (typeof issuer !== "string" || typeof sub !== "string") {
    throw new Error("a session has its account");
  }
  return {
    token,
    expiresAt: expires_at as number,
    name,
    email,
    issuer,
    sub,
  };
}

/** Exchanges `code` with the attempt's verifier (ID-21): the session, or
 * `refused` (`401`: unknown, expired, used, or another tab's code).
 * Rejects on anything else. */
export async function exchangeSignInCode(
  gateway: string,
  code: string,
  attempt: SignInAttempt,
  fetchFn: Fetch = fetch,
): Promise<GatewaySession | "refused"> {
  const response = await fetchFn(new URL("/accounts/session", gateway).href, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, verifier: attempt.verifier }),
  });
  if (response.status === 401) return "refused";
  if (response.status !== 200) {
    throw new Error(`the gateway answered ${response.status}`);
  }
  return readGatewaySession(await response.json());
}

/** Ends `token` (ID-22); `401` is fine: it had ended already. */
export async function endGatewaySession(
  gateway: string,
  token: string,
  fetchFn: Fetch = fetch,
): Promise<void> {
  const response = await fetchFn(new URL("/accounts/logout", gateway).href, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status !== 204 && response.status !== 401) {
    throw new Error(`the gateway answered ${response.status}`);
  }
}

/** Whether the gateway answers `/accounts/health` within `ms` (ID-22,
 * ADR-0041 point 6). Never rejects. */
export function gatewayHealthy(
  gateway: string,
  options: {
    fetch?: Fetch;
    setTimer(run: () => void, ms: number): () => void;
    ms?: number;
  },
): Promise<boolean> {
  const fetchFn = options.fetch ?? fetch;
  const abort = new AbortController();
  return new Promise((resolve) => {
    const cancel = options.setTimer(() => {
      abort.abort();
      resolve(false);
    }, options.ms ?? 3000);
    fetchFn(new URL("/accounts/health", gateway).href, {
      signal: abort.signal,
    }).then(
      (response) => {
        cancel();
        resolve(response.status === 200);
      },
      () => {
        cancel();
        resolve(false);
      },
    );
  });
}
