/** The page's service worker (SW5): it serves the page offline
 * once it has been opened online (`src/sw/`). Registered once the document
 * is open, so as not to compete with opening it. */
export async function registerServiceWorker(
  container:
    | { register(url: string): Promise<unknown> }
    | undefined = navigator.serviceWorker,
  log: (...args: unknown[]) => void = console.warn,
): Promise<void> {
  if (!container) return;
  try {
    // Next to the page: its scope is the page's directory.
    await container.register("./sw.js");
  } catch (error) {
    log("service worker not registered", error);
  }
}
