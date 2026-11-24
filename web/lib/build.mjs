// `npm run build:lib`: bundles the library into lib/dist/index.js, an ES
// module for Node (22 and later) and bundlers. `loro-crdt` stays an
// import: each platform resolves its own build of it.
import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: [new URL("src/index.ts", import.meta.url).pathname],
  outfile: new URL("dist/index.js", import.meta.url).pathname,
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  external: ["loro-crdt"],
  logLevel: "warning",
});
