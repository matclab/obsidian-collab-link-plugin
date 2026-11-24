// Which remote images the page may load, once the reader grants them
// (ADR-0055 §2, §11): the preview's rule, and the editor's.

/** A '/' after the host: an image's address has a path, and a domain
 * still being typed is not requested (ADR-0055 §11). */
const WITH_PATH = /^https:\/\/[^/?#\\]+\//i;

/** Names of the reader's own network, as written (ADR-0055 §11, R4). */
const LOCAL_NAME = /(^|\.)(localhost|local|internal|home\.arpa)$/;

/** The address an image is loaded from, normalized as the browser reads
 * it, or null if it never is: not https, no '/' after its host,
 * credentials, or a host of the reader's network — a local name, a name
 * without a dot, an IP address in any spelling the browser reads. */
export function loadableImageSource(src: string): string | null {
  if (!WITH_PATH.test(src)) return null;
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "") return null;
  const host = url.hostname.replace(/\.$/, "");
  if (
    !host.includes(".") ||
    host.startsWith("[") ||
    /^[0-9.]+$/.test(host) ||
    LOCAL_NAME.test(host)
  ) {
    return null;
  }
  return url.href;
}
