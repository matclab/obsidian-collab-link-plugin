import type { RequestUrlParam, RequestUrlResponse } from "obsidian";

const LOCAL = ["localhost", "127.0.0.1", "[::1]"];

/** The server's origin from its address in the settings
 * (docs/phase-14-plugin-obsidian.md, decision 9): https, or http to this
 * computer only — a link's secret never crosses the network in clear. */
export function serverOrigin(
  text: string,
):
  | { ok: true; origin: string }
  | { ok: false; problem: "not-a-server" | "insecure" } {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return { ok: false, problem: "not-a-server" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, problem: "not-a-server" };
  }
  if (url.protocol === "http:" && !LOCAL.includes(url.hostname)) {
    return { ok: false, problem: "insecure" };
  }
  return { ok: true, origin: url.origin };
}

/** `Authorization: Basic …` for `user` and `password`, in UTF-8. */
function basic(user: string, password: string): string {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  return `Basic ${btoa(String.fromCharCode(...bytes))}`;
}

/** `headers`, as an object (no iterator in the plugin's types). */
function namesOf(headers: Headers): Record<string, string> {
  const named: Record<string, string> = {};
  headers.forEach((value, name) => {
    named[name] = value;
  });
  return named;
}

/** A `fetch` over Obsidian's `requestUrl`, which no CORS stops: the keyring's
 * requests (M1) — bytes both ways, the answer's headers (`ETag`) — and the
 * gateway's, without `Origin` (ID-23); with the name and password of decision
 * 18, if given. */
export function requestFetch(
  requestUrl: (param: RequestUrlParam) => Promise<RequestUrlResponse>,
  auth?: { user: string; password: string },
): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url, init = {}) => {
    // A plain object as it is; `Headers` or pairs, by their names.
    const given =
      init.headers instanceof Headers || Array.isArray(init.headers)
        ? namesOf(new Headers(init.headers))
        : (init.headers as Record<string, string> | undefined);
    const headers: Record<string, string> = {
      ...given,
      ...(auth && { Authorization: basic(auth.user, auth.password) }),
    };
    const { body } = init;
    const sent: string | ArrayBuffer | undefined =
      typeof body === "string"
        ? body
        : ArrayBuffer.isView(body)
          ? new Uint8Array(
              body.buffer,
              body.byteOffset,
              body.byteLength,
            ).slice().buffer
          : body instanceof ArrayBuffer
            ? body
            : undefined;
    const response = await requestUrl({
      url,
      method: init.method ?? "GET",
      headers,
      ...(sent !== undefined && { body: sent }),
      throw: false,
    });
    // A status without a body (204, 304…) takes none.
    const empty = [101, 204, 205, 304].includes(response.status);
    const bytes = response.arrayBuffer;
    return new Response(
      empty ? null : bytes && bytes.byteLength > 0 ? bytes : response.text,
      { status: response.status, headers: response.headers },
    );
  };
}

/** `requestFetch` for `createDocument`, with the name and password of
 * decision 18, if set. Used for creating a document only: the server's
 * address is the settings'. */
export function creationFetch(
  requestUrl: (param: RequestUrlParam) => Promise<RequestUrlResponse>,
  auth: { user: string; password: string } | undefined,
): (url: string, init?: RequestInit) => Promise<Response> {
  return requestFetch(requestUrl, auth);
}

/** What the server says of the name and password of the settings. */
export type CredentialsCheck =
  | "accepted"
  | "refused"
  | "missing"
  | "not-asked"
  | "unreachable";

/** Tests the name and password of decision 18 with `GET /documents`,
 * which creates nothing: nginx's `auth_basic` answers 401 before the
 * server, which answers 405. Asked first without them, to tell a server
 * that asks for none from one that accepts them. */
export async function checkCredentials(
  origin: string,
  requestUrl: (param: RequestUrlParam) => Promise<RequestUrlResponse>,
  auth: { user: string; password: string } | undefined,
): Promise<CredentialsCheck> {
  const asked = async (given: typeof auth) => {
    const response = await requestUrl({
      url: `${origin}/documents`,
      method: "GET",
      headers: given
        ? { Authorization: basic(given.user, given.password) }
        : {},
      throw: false,
    });
    return response.status === 401;
  };
  try {
    if (!(await asked(undefined))) return "not-asked";
    if (!auth) return "missing";
    return (await asked(auth)) ? "refused" : "accepted";
  } catch {
    return "unreachable";
  }
}
