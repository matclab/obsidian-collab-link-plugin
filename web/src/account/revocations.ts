/** The revocation list in the page (docs/protocol/06-identity.md, ID-40, case
 * 6): `GET /revocations` on the server's origin, read
 * when the view opens and every 10 minutes, at the gateway's pace; the
 * valid list of greatest signed `issuedAt` retained, never an older one
 * (AT4). Offline, the service worker serves the last one it saw. */
import {
  type RevocationList,
  newerList,
  readRevocationBody,
} from "../../lib/src/index.js";

/** How often the list is read again (ID-40: at least every 10 minutes). */
export const REREAD_MS = 10 * 60 * 1000;

export interface RevocationReaderOptions {
  apiBase: string;
  /** The attestation keys trusted (`/config.json`). */
  configured: ReadonlySet<string>;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  setTimer(run: () => void, ms: number): () => void;
}

/** What a view needs of the list: the one retained, and to be told when
 * a newer one is. */
export interface RevocationSource {
  current(): RevocationList | undefined;
  subscribe(listener: () => void): () => void;
}

export class RevocationReader implements RevocationSource {
  private list: RevocationList | undefined;
  private readonly listeners = new Set<() => void>();
  private cancelTimer = () => {};
  private closed = false;

  constructor(private readonly options: RevocationReaderOptions) {}

  current(): RevocationList | undefined {
    return this.list;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private reading: Promise<void> = Promise.resolve();

  /** Resolves once the reading in progress, if any, ended (tests). */
  settled(): Promise<void> {
    return this.reading;
  }

  /** Reads the list now, then again in `REREAD_MS`. Never rejects. */
  read(): Promise<void> {
    this.reading = this.readNow();
    return this.reading;
  }

  private async readNow(): Promise<void> {
    this.cancelTimer();
    let read: RevocationList | undefined;
    try {
      const response = await this.options.fetch(
        new URL("/revocations", this.options.apiBase).href,
      );
      if (response.status === 200) {
        read = await readRevocationBody(
          await response.text(),
          this.options.configured,
        );
      }
    } catch {
      read = undefined;
    }
    if (this.closed) return;
    const kept = newerList(this.list, read);
    if (kept !== this.list) {
      this.list = kept;
      for (const listener of [...this.listeners]) listener();
    }
    this.cancelTimer = this.options.setTimer(() => void this.read(), REREAD_MS);
  }

  close(): void {
    this.closed = true;
    this.cancelTimer();
    this.cancelTimer = () => {};
    this.listeners.clear();
  }
}
