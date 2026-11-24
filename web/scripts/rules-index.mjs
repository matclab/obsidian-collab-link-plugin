// `node scripts/rules-index.mjs` (in web/): writes docs/rules-index.md, the
// index of the rule identifiers (src/docs/rules-index.ts).
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { definitions, render } from "../src/docs/rules-index.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
writeFileSync(path.join(root, "docs/rules-index.md"), render(definitions(root)));
console.log("wrote docs/rules-index.md");
