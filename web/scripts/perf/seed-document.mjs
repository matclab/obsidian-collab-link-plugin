// Creates a document on a server and journals a generated one
// (profile-document.mjs) into it, as one snapshot entry per CRDT channel —
// what a compacted document's journal holds (ADR-0017). Prints the
// document's links as JSON. Run `npm run build:lib` first. `--sign`: every
// annotation, reply, named version and name in `peers` signed first
// (docs/protocol/06-identity.md), for the identifier the server gives.
//
//   node scripts/perf/seed-document.mjs [--server http://127.0.0.1:8080] [--from perf-out/profile] [--sign true]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LoroDoc, LoroList, LoroMap } from "loro-crdt";
import {
  addIdentity,
  annotationMessage,
  bytesToBase64Url,
  createDocument,
  deriveRoleSecrets,
  documentLinks,
  encrypt,
  generateIdentityKey,
  peerMessage,
  peerNames,
  readAnnotationEntry,
  readVersionEntries,
  replyMessage,
  sign,
  signerOf,
  versionMessage,
} from "../../lib/dist/index.js";
import { args } from "./args.mjs";

const { server, from, sign: signing } = args({
  server: "http://127.0.0.1:8080",
  from: "perf-out/profile",
  sign: "",
});
const created = await createDocument(server);
const { edit } = await deriveRoleSecrets(created.editSecret);
let annotationsSnapshot = readFileSync(join(from, "annotations.snapshot"));
if (signing) annotationsSnapshot = await signAll(annotationsSnapshot);
const channels = [
  [0, readFileSync(join(from, "content.snapshot"))],
  [1, annotationsSnapshot],
];

/** Signs every object of the annotations doc, one key, one commit. */
async function signAll(snapshot) {
  const doc = new LoroDoc();
  doc.import(snapshot);
  const signer = await signerOf(await generateIdentityKey());
  const context = (s) => ({ documentId: created.documentId, signer: s });
  addIdentity(doc, signer);
  const entries = doc.getMap("annotations");
  for (const id of entries.keys()) {
    const read = readAnnotationEntry(doc, id);
    if (!read) continue;
    const entry = entries.get(id);
    entry.set("sig", await sign(signer, (s) => annotationMessage(context(s), id, read.fields)));
    const replies = entry.get("replies");
    if (!(replies instanceof LoroList)) continue;
    for (let i = 0; i < replies.length; i++) {
      const reply = replies.get(i);
      if (!(reply instanceof LoroMap)) continue;
      const replyId = crypto.randomUUID();
      reply.set("id", replyId);
      const fields = { annotation: id, author: reply.get("author"), createdAt: reply.get("createdAt"), body: reply.get("body") };
      reply.set("sig", await sign(signer, (s) => replyMessage(context(s), replyId, fields)));
    }
  }
  for (const version of readVersionEntries(doc)) {
    const entry = doc.getMap("versions").get(version.id);
    entry.set("sig", await sign(signer, (s) => versionMessage(context(s), version.id, version)));
  }
  for (const [peer, name] of peerNames(doc)) {
    doc.getMap("peerSignatures").set(peer, await sign(signer, (s) => peerMessage(context(s), peer, name)));
  }
  doc.commit();
  return doc.export({ mode: "snapshot" });
}

const socket = new WebSocket(`${server.replace(/^http/, "ws")}/ws`);
socket.binaryType = "arraybuffer";
await new Promise((resolve, reject) => {
  let acks = 0;
  socket.onerror = () => reject(new Error("connection failed"));
  socket.onclose = ({ code }) => reject(new Error(`closed ${code}`));
  socket.onmessage = ({ data }) => {
    if (typeof data === "string" && data.includes('"ack"') && ++acks === channels.length) {
      socket.onclose = null;
      socket.close();
      resolve();
    }
  };
  socket.onopen = async () => {
    socket.send(JSON.stringify({ auth: created.documentId, v: 1, role: "edit", secret: bytesToBase64Url(edit) }));
    for (const [channel, snapshot] of channels) {
      const blob = await encrypt(created.key, snapshot);
      const frame = new Uint8Array(1 + blob.length);
      frame[0] = channel;
      frame.set(blob, 1);
      socket.send(frame);
    }
  };
});
const links = await documentLinks(`${server}/`, created.documentId, created.keyMaterial, created.editSecret);
console.log(JSON.stringify({ documentId: created.documentId, ...links }));
