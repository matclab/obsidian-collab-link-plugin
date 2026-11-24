/** Timing spans for `?perf` (docs/phase-4ter-*.md, step 1): when enabled,
 * each span becomes a named `performance.measure` (`oc:<name>`), visible in
 * the DevTools Performance panel, and its time adds up in `timings()`. Off
 * by default: a span is then a plain call. */

let enabled = false;
const totals = new Map<string, { total: number; calls: number }>();

export function enableMarks(): void {
  enabled = true;
}

export function span<T>(name: string, run: () => T): T {
  if (!enabled) return run();
  const start = performance.now();
  try {
    return run();
  } finally {
    const end = performance.now();
    performance.measure(`oc:${name}`, { start, end });
    const entry = totals.get(name) ?? { total: 0, calls: 0 };
    entry.total += end - start;
    entry.calls++;
    totals.set(name, entry);
  }
}

/** A measure from `start` (a `performance.now()` value) to now. */
export function measureSince(name: string, start: number): number {
  const end = performance.now();
  if (enabled) performance.measure(`oc:${name}`, { start, end });
  return end - start;
}

/** Total milliseconds and calls per span name since the last reset. */
export function timings(): Record<string, { total: number; calls: number }> {
  return Object.fromEntries(
    [...totals].map(([name, { total, calls }]) => [name, { total, calls }]),
  );
}

export function resetTimings(): void {
  totals.clear();
}
