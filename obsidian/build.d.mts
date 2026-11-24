import type { BuildResult } from "esbuild";

export function buildPlugin(options?: {
  outdir?: string;
  minify?: boolean;
  logLevel?: "silent" | "error" | "warning" | "info";
}): Promise<BuildResult<{ metafile: true }>>;
