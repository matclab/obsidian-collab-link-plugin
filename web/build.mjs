// `npm run build [-- --minify]`: the page, into `dist/` (see build-page.mjs).
import { buildPage } from "./build-page.mjs";

await buildPage({ outdir: "dist", minify: process.argv.includes("--minify") });
