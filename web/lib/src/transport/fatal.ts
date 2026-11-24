/** A panic inside Loro's WebAssembly: a `WebAssembly.RuntimeError`
 * ("unreachable"), after which the document it hit is poisoned
 * (docs/phase-9-durcissement.md, L4). An ordinary error of Loro
 * (an update it refuses) leaves the document usable, and isn't one. The
 * name too, for an error of another realm. */
export function isWasmTrap(error: unknown): boolean {
  return (
    error instanceof WebAssembly.RuntimeError ||
    (error instanceof Error && error.name === "RuntimeError")
  );
}
