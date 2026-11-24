/** What the service worker does with a request (SW3), as pure
 * functions: `sw.ts` only wires them to the browser's events. */

/** The files of one version of the page, written by the build. Paths are
 * relative to the worker's scope (the page's directory). */
export interface Manifest {
  version: string;
  /** The bundle the page of this version loads. */
  entry: string;
  /** Fetched at installation: what opening a document needs (SW4). */
  precache: string[];
  /** Every file of this version; the others are kept on first use. */
  files: string[];
}

export type Decision =
  /** The page: network first, this version's copy if the network fails. */
  | { kind: "page" }
  /** A file of this version: its cache, else the network (then kept). */
  | { kind: "file"; path: string }
  /** What the deployment tells the page: the network
   * first, the last answer kept, served offline (decision 13). */
  | { kind: "deployment"; path: string }
  /** Not intercepted: the API, the WebSocket, anything else. */
  | { kind: "pass" };

/** `/config.json`, and the revocation list the server serves (ID-35). */
const DEPLOYMENT = ["config.json", "revocations"];

export function decide(
  request: { url: string; mode: string; method: string },
  scope: string,
  manifest: Manifest,
): Decision {
  if (request.method !== "GET") return { kind: "pass" };
  const url = new URL(request.url);
  const root = new URL(scope);
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) {
    return { kind: "pass" };
  }
  const path = url.pathname.slice(root.pathname.length);
  if (request.mode === "navigate") {
    return path === "" || path === "index.html"
      ? { kind: "page" }
      : { kind: "pass" };
  }
  if (url.search !== "" || path === "index.html") return { kind: "pass" };
  if (DEPLOYMENT.includes(path)) return { kind: "deployment", path };
  return manifest.files.includes(path)
    ? { kind: "file", path }
    : { kind: "pass" };
}

const PREFIX = "oc-";

export function cacheName(version: string): string {
  return `${PREFIX}${version}`;
}

/** This page's caches of other versions; caches of anything else on the
 * origin are not this worker's business. */
export function staleCaches(names: string[], version: string): string[] {
  return names.filter(
    (name) => name.startsWith(PREFIX) && name !== cacheName(version),
  );
}

/** Whether the page fetched at installation is the one of this version: a
 * deployment between the worker and the page would mix them (piège 1). */
export function pageMatches(html: string, manifest: Manifest): boolean {
  return html.includes(`src="./${manifest.entry}"`);
}
