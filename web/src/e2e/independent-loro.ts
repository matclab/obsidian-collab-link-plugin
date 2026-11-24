// The independent client's only dependency, linked (not in git) to the
// version the specification was written against, 1.16.3, while the
// official client runs a later one (phase 9, L1): two WebAssembly modules
// in one process, and the format checked across versions. Shared by the
// e2e files that load the independent client, which run alongside: a link
// another file just made is not an error. A link to a folder that is gone
// (the project moved) is replaced.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

/** The link in `base` (the repository, by default) made if it is missing. */
export function linkIndependentLoro(base = root): void {
  const loroLink = path.join(base, "independent-client/node_modules/loro-crdt");
  const loroTarget = path.join(base, "web/node_modules/loro-crdt-1163");
  // existsSync follows the link: a dangling one would look absent and stay.
  const present = lstatSync(loroLink, { throwIfNoEntry: false }) !== undefined;
  if (
    present &&
    (!existsSync(loroLink) ||
      realpathSync(loroLink) !== realpathSync(loroTarget))
  ) {
    rmSync(loroLink);
  } else if (present) {
    return;
  }
  mkdirSync(path.dirname(loroLink), { recursive: true });
  try {
    symlinkSync(loroTarget, loroLink);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}
