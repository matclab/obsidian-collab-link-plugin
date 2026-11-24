import type { BuildResult } from "esbuild";

export function buildPlugin(options?: {
  outdir?: string;
  minify?: boolean;
  logLevel?: "silent" | "error" | "warning" | "info";
}): Promise<
  BuildResult<{ metafile: true }> & { styles: BuildResult<{ metafile: true }> }
>;

/** What the build reads, from the repository's root (obsidian/'s parent),
 * the dependencies left out. */
export function sources(): Promise<string[]>;
