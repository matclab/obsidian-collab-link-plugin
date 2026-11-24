# obsidian-collab-client

The reference implementation of the [obsidian-collab protocol](../../docs/protocol/README.md), without a page: the official web client is built on it, and another client — an Obsidian plugin, a script — can use it too. It is written in TypeScript, depends only on [`loro-crdt`](https://loro.dev), and runs in browsers and in Node 22 or later.

Not published on npm yet: use it from this repository (`npm run build:lib` in `web/` writes `lib/dist/index.js`; TypeScript users can import `lib/src/index.ts` directly).

## Open, read, write, leave

```js
import { listAnnotations, openLink } from "obsidian-collab-client";

// A link as the page gives it: <page>?doc=<id>#k=<key>&r=<role>.<secret>
const doc = await openLink(link);

// The text is a Loro text; the annotations live in a second document.
const text = doc.content.getText("content");
console.log(text.toString());
for (const annotation of listAnnotations(doc.content, doc.annotations)) {
  console.log(annotation.type, annotation.author, annotation.range);
}

// Write, then wait until the server holds it before leaving.
text.insert(text.length, "\nA new line.");
doc.content.commit();
await doc.whenPublished();
doc.close();
```

`openLink` reads the key and the role's secret from the link's fragment, connects, and resolves once the text, the annotations and the decisions so far are imported. Changes from others then arrive in `doc.content` and `doc.annotations`: subscribe to them with Loro (`doc.content.subscribe(…)`).

- **The server** is the link's origin by default: the server serves the page. Otherwise pass it: `openLink(link, { server: "https://collab.example" })`. A secret never travels without TLS, except to the local machine.
- **Writing** is what Loro does: change `doc.content` or `doc.annotations`, then `commit()`. The connection publishes this client's own operations, in frames under the server's size limit, and publishes again what wasn't acknowledged after a reconnection. A reader's role writes nothing that leaves; a reviewer's (`suggest`) only annotations.
- **Decisions**: `doc.decisions` holds the confirmed journal of decisions; `doc.decisions.winner(id)` for a suggestion, `doc.decisions.resolution(id)` for a comment.
- **A refusal** after the connection is up (deleted document, renewed links) is reported with `onRefused(code)`; before, `openLink` rejects with a `ConnectionRefused`.

A runnable version: [`examples/read-and-write.mjs`](examples/read-and-write.mjs).

```sh
cd web && npm run build:lib
node lib/examples/read-and-write.mjs '<link>' 'text to append'
```

## By profile

The [specification](../../docs/protocol/04-obligations.md) defines three profiles. This library implements the complete one; the groups of its entry (`src/index.ts`) say what each profile uses.

| Profile | What to use |
|---|---|
| reader | `openLink`, `listAnnotations`, `resolveAnnotation`, `DecisionLog`, `listVersions`, `peerNames`, `Presence` (to show who is here) |
| text editor | + write into `content`; `tryCreateAnnotation`, `suggestAddition`, `createDetachedChange` for suggestions and comments; `registerOnFirstEdit` to sign one's edits |
| complete | + `LocalDecisions` to accept, reject, resolve; `watchDecisionEffects` to apply the decisions' effects (editors only); `createDocument`, `documentLinks`, `renewLinks`; `connection.deleteDocument()`, `connection.setExpiry()` |

Lower level: `connectDocument` is the transport `openLink` is built on, for a client that manages its own Loro documents or keeps them between sessions (`TransportState`, `resume`, `onAcked`).

## What it guarantees, and what it doesn't

It follows the specification's rules, checked by its tests and by the [test vectors](../../docs/protocol/vectors.json) shared with the server. It never sends the key nor a secret but the one of its role, at authentication.

It doesn't keep anything between sessions: a client that wants to must store its documents with the cursors that match them ([O-12, O-13](../../docs/protocol/04-obligations.md)). It doesn't render Markdown: what a document holds is untrusted input ([D-36](../../docs/protocol/03-document.md)).
