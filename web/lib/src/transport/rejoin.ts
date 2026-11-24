/** When to rejoin a record-log channel (`decisions`, docs/adr/0013-*.md).
 * A pushed frame or an ack on that channel is only a *signal* — only a
 * history reply confirms (docs/adr/0011-*.md) — so every signal must lead
 * to a join whose reply is computed after it. At most one join is in
 * flight: a signal that arrives meanwhile may predate or postdate the
 * server computing that reply, which this client cannot tell, so it marks
 * the join dirty and sends exactly one more after the reply. Dropping such
 * a signal instead loses the proposal until the next unrelated signal —
 * the counterexample of `Proposed2`'s `@covered` invariant
 * (formal/decision-protocol). Pure state machine; `sendJoin` does the I/O. */
export class RejoinCoalescer {
  private connection = false;
  private inFlight = false;
  private dirty = false;

  constructor(private readonly sendJoin: () => void) {}

  /** A (re)connection always joins, whatever was pending before. */
  connected(): void {
    this.connection = true;
    this.inFlight = true;
    this.dirty = false;
    this.sendJoin();
  }

  /** In-flight joins and pending signals die with the connection; the
   * next `connected()` covers everything since the confirmed cursor. */
  disconnected(): void {
    this.connection = false;
    this.inFlight = false;
    this.dirty = false;
  }

  signal(): void {
    if (!this.connection) return;
    if (this.inFlight) {
      this.dirty = true;
      return;
    }
    this.inFlight = true;
    this.sendJoin();
  }

  /** The reply to the in-flight join has been fully delivered. */
  replied(): void {
    if (!this.inFlight) return;
    if (this.dirty) {
      this.dirty = false;
      this.sendJoin();
      return;
    }
    this.inFlight = false;
  }
}
