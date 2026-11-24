/** Whether this Obsidian's WebCrypto has Ed25519 (ADR-0040, point 75):
 * an Electron before 37, from an old installer, hasn't; the plugin then
 * signs nothing, and says so. */
export async function ed25519Supported(
  subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle,
): Promise<boolean> {
  try {
    if (!subtle) return false;
    await subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
    return true;
  } catch {
    return false;
  }
}
