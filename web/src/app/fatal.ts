import { isWasmTrap } from "../../lib/src/index.js";

/** Calls `onTrap` for a Loro panic that surfaces as an uncaught error or
 * an unhandled rejection of `target` (the window): the editor binding, the
 * annotation index or a preview may hit a poisoned document, not only the
 * transport (docs/phase-9-durcissement.md, L4). Every other error
 * is left alone. Returns a function that stops watching. */
export function watchForTraps(
  target: EventTarget,
  onTrap: (error: unknown) => void,
): () => void {
  const onError = (event: Event) => {
    const { error } = event as ErrorEvent;
    if (isWasmTrap(error)) onTrap(error);
  };
  const onRejection = (event: Event) => {
    const { reason } = event as PromiseRejectionEvent;
    if (isWasmTrap(reason)) onTrap(reason);
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}
