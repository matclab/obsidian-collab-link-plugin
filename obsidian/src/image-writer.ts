// A view's attached images, written to the vault (ADR-0058 §2): with the
// bytes its images service has already decrypted, one image at a time,
// each tried once by the view; a file is created, never replaced; then
// the export is told, which cites it (§1). Nothing after `stop`.
import type { ImageFormat, OpenedImage } from "../../web/lib/src/index.js";

export class ImageWriter {
  private readonly options: {
    /** The setting (§2). */
    enabled: () => boolean;
    /** The format of the image's file in the vault, if it is there. */
    found: (id: string) => ImageFormat | undefined;
    /** The image's bytes, from the view; `undefined` if it can't be had. */
    image: (id: string) => Promise<OpenedImage | undefined>;
    /** Creates its file; rejects if the name is taken. */
    create: (id: string, image: OpenedImage) => Promise<void>;
    /** A file was written. */
    written: () => void;
  };
  private readonly tried = new Set<string>();
  private readonly queue: string[] = [];
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(options: ImageWriter["options"]) {
    this.options = options;
  }

  /** The identifiers the document's text cites now. */
  cited(ids: readonly string[]): void {
    if (this.stopped || !this.options.enabled()) return;
    for (const id of ids) {
      if (this.tried.has(id) || this.options.found(id)) continue;
      this.tried.add(id);
      this.queue.push(id);
    }
    this.running ??= this.run().finally(() => {
      this.running = undefined;
    });
  }

  /** Resolves once a file being created is. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.queue.length = 0;
    await this.running;
  }

  private async run(): Promise<void> {
    for (let id = this.queue.shift(); id; id = this.queue.shift()) {
      const image = await this.options.image(id).catch(() => undefined);
      if (this.stopped) return;
      if (!image || !this.options.enabled() || this.options.found(id)) {
        continue;
      }
      try {
        await this.options.create(id, image);
      } catch (error) {
        console.warn("collab-link: an attached image not written", error);
        continue;
      }
      if (!this.stopped) this.options.written();
    }
  }
}
