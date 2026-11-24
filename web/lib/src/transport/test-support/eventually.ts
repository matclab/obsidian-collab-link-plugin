/** Waits until `condition` holds, polling — instead of a fixed sleep that
 * is too short when the machine is busy (the whole suite runs property
 * tests in parallel) and needlessly long when it isn't. */
export async function eventually(
  condition: () => boolean,
  // Only a test that hangs waits this long: 2 s was too short with the
  // suite on a loaded machine.
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
