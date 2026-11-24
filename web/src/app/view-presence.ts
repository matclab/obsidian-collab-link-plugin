import { SignatureIndex } from "../../lib/src/index.js";
import { nameRemoteCursors } from "../editor/remote-cursors.js";
import { shownName } from "../ui/annotations/card-model.js";
import { createHereNow } from "../ui/header/here-now.js";
import type { OpenedDocument } from "./open-document.js";

/** Who is here (R-P5): the list in the bar, and the carets named as it
 * names them — the attested name. `trusted` ties the presence's
 * signatures to the trust of the gateway. */
export function followPresence(
  opened: Pick<OpenedDocument, "client" | "annotationsDoc" | "presence">,
  options: {
    documentId: string;
    parent: HTMLElement;
    trusted<T extends SignatureIndex>(index: T): T;
    stops: (() => void)[];
  },
): void {
  const presenceSignatures = options.trusted(
    new SignatureIndex({
      documentId: options.documentId,
      annotationsDoc: opened.annotationsDoc,
      log: opened.client.log,
      presence: opened.presence,
    }),
  );
  createHereNow(options.parent, opened.presence, presenceSignatures);
  options.stops.push(
    nameRemoteCursors(opened.client.editor.view, {
      name: (other) => {
        const verdict = presenceSignatures.current().of("presence", other.key);
        return verdict
          ? {
              name: shownName(other.name, verdict),
              attested: verdict.signed && verdict.attested !== undefined,
            }
          : { name: other.name, attested: false };
      },
      subscribe: (listener) => presenceSignatures.subscribe(listener),
    }),
  );
}
