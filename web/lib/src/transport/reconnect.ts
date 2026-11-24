import { CloseCode } from "./protocol.js";

/** After `4429` (the document's connection cap): 1 s, doubled at each
 * refusal in a row, at most 30 s, ±20 % so that refused clients don't all
 * come back at once. */
const CROWDED_FIRST_DELAY_MS = 1000;
const CROWDED_MAX_DELAY_MS = 30_000;

/** The server's codes after which reconnecting may succeed; any other
 * `44xx`, known or not, would only be refused again
 * (docs/phase-8-protocole-ouvert.md, N5): an older client doesn't hammer
 * a server with a refusal it doesn't know. */
const PASSING_CODES: readonly number[] = [
  CloseCode.TooSlow,
  CloseCode.TooManyConnections,
];

function isFinal(code: number): boolean {
  return code >= 4400 && code <= 4499 && !PASSING_CODES.includes(code);
}

/** When to connect again after a close (ADR-0019 §4). */
export class ReconnectPolicy {
  /** `4429` refusals in a row. */
  private crowded = 0;

  constructor(
    private readonly delayMs: number,
    private readonly random: () => number = Math.random,
  ) {}

  /** The wait before connecting again after `code`, or `undefined` for
   * never. */
  delay(code: number): number | undefined {
    if (isFinal(code)) return undefined;
    if (code !== CloseCode.TooManyConnections) return this.delayMs;
    const delay = Math.min(
      CROWDED_MAX_DELAY_MS,
      CROWDED_FIRST_DELAY_MS * 2 ** this.crowded,
    );
    this.crowded++;
    return delay * (0.8 + 0.4 * this.random());
  }

  /** A connection got through: the next `4429` waits from the start. */
  authenticated(): void {
    this.crowded = 0;
  }
}
