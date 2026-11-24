// Writes docs/protocol/vectors.json: the test vectors of the protocol
// specification (docs/protocol/), read by the Rust and TypeScript tests.
//
// Independent of the code it checks: nothing here imports `web/src` nor
// the server. Hashes, HKDF and AES-GCM come from `node:crypto`, base64
// from `Buffer`, Loro bytes from the raw `loro-crdt` API following the
// specification's rules; the expected outcomes of validity cases are
// written by hand from the specification, never computed by the
// functions under test. Run once when the specification changes
// (`node scripts/generate-protocol-vectors.mjs`), never by the tests: a
// vector that the code no longer matches is a failure to look at, not
// something to regenerate.
import {
  createCipheriv,
  createECDH,
  createHash,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  sign as edSign,
} from "node:crypto";
import { writeFileSync } from "node:fs";
// The version the specification names (D-1): the official client may run
// a later one (phase 9, L1), the vectors stay those of 1.16.3.
import { Cursor, LoroDoc, LoroList, LoroMap } from "loro-crdt-1163";

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const utf8 = (text) => Buffer.from(text, "utf8");
const range = (from, count) =>
  Uint8Array.from({ length: count }, (_, i) => (from + i) & 0xff);

// --- 2. Links and encryption -------------------------------------------

const edit = range(0x01, 32);
const hkdf = (info) =>
  new Uint8Array(hkdfSync("sha256", edit, new Uint8Array(0), utf8(info), 32));
const secrets = {
  read: hkdf("obsidian-collab/read/v1"),
  suggest: hkdf("obsidian-collab/suggest/v1"),
  edit,
};
const verifier = (role, secret) =>
  createHash("sha256")
    .update(utf8("obsidian-collab/verifier/v1"))
    .update(Uint8Array.of(0))
    .update(utf8(role))
    .update(Uint8Array.of(0))
    .update(secret)
    .digest();

const key = range(0xa0, 32);
const encrypt = (nonce, plaintext) => {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
};
const nonce = range(0x10, 12);
const blob = encrypt(nonce, utf8("hello, world"));
const tampered = Buffer.from(blob);
tampered[tampered.length - 1] ^= 1;

const keys = {
  edit_secret: hex(edit),
  role_secrets: {
    read: hex(secrets.read),
    suggest: hex(secrets.suggest),
    edit: hex(secrets.edit),
  },
  verifiers: [
    ...["read", "suggest", "edit"].map((role) => ({
      role,
      secret: hex(secrets[role]),
      verifier: hex(verifier(role, secrets[role])),
    })),
    {
      role: "suggest",
      secret: hex(new Uint8Array(32).fill(0x42)),
      verifier: hex(verifier("suggest", new Uint8Array(32).fill(0x42))),
    },
  ],
  content_key: { hex: hex(key), base64url: b64url(key) },
  blobs: [
    {
      nonce: hex(nonce),
      plaintext: hex(utf8("hello, world")),
      blob: hex(blob),
    },
    { nonce: hex(range(0x77, 12)), plaintext: "", blob: hex(encrypt(range(0x77, 12), new Uint8Array(0))) },
  ],
  blobs_that_dont_decrypt: [
    { why: "last byte of the tag altered", blob: hex(tampered) },
    { why: "shorter than a nonce and a tag", blob: hex(range(0, 20)) },
  ],
  links: {
    valid: ["read", "suggest", "edit"].map((role) => ({
      fragment: `#k=${b64url(key)}&r=${role}.${b64url(secrets[role])}`,
      key: b64url(key),
      role,
      secret: hex(secrets[role]),
    })),
    invalid: [
      { why: "no key", fragment: `#r=edit.${b64url(edit)}` },
      { why: "a link from before roles", fragment: `#${b64url(key)}` },
      { why: "a key of 16 bytes", fragment: `#k=${b64url(key.slice(0, 16))}&r=edit.${b64url(edit)}` },
      { why: "unknown role", fragment: `#k=${b64url(key)}&r=admin.${b64url(edit)}` },
      { why: "secret of 31 bytes", fragment: `#k=${b64url(key)}&r=edit.${b64url(edit.slice(1))}` },
      { why: "secret not base64url", fragment: `#k=${b64url(key)}&r=edit.${b64(edit)}+` },
      { why: "two dots", fragment: `#k=${b64url(key)}&r=edit.${b64url(edit)}.x` },
    ],
  },
};

// --- 1. The wire -------------------------------------------------------

const DOC = "0123456789abcdef0123456789abcdef";
const verifiersJson = Object.fromEntries(
  ["read", "suggest", "edit"].map((role) => [role, b64url(verifier(role, secrets[role]))]),
);
const snapshotBytes = range(0xc0, 7);

const wire = {
  protocol_version: 1,
  client_messages: [
    { name: "auth", json: { auth: DOC, v: 1, role: "suggest", secret: b64url(secrets.suggest) } },
    { name: "join", json: { join: DOC, channel: "content" } },
    { name: "join since", json: { join: DOC, channel: "decisions", since: 42 } },
    { name: "compact", json: { compact: DOC, channel: "annotations", up_to_seq: 9, snapshot: b64(snapshotBytes) } },
    { name: "rotate", json: { rotate: verifiersJson } },
    { name: "delete", json: { delete: DOC } },
    { name: "expire", json: { expire: DOC, in: 3600 } },
    { name: "expire none", json: { expire: DOC, in: null } },
  ],
  create_document: { v: 1, verifiers: verifiersJson },
  // `parsed_as`: how the message reads; `close`: the code the server closes
  // with — before authentication every refusal is 4401, but a version it
  // doesn't speak 4426 (W-10).
  client_messages_refused: [
    { why: "auth without v", json: { auth: DOC, role: "edit", secret: b64url(edit) }, parsed_as: "unsupported_version", close: 4426 },
    { why: "auth of version 2", json: { auth: DOC, v: 2, role: "edit", secret: b64url(edit) }, parsed_as: "unsupported_version", close: 4426 },
    { why: "v as a string", json: { auth: DOC, v: "1", role: "edit", secret: b64url(edit) }, parsed_as: "unsupported_version", close: 4426 },
    { why: "unknown role", json: { auth: DOC, v: 1, role: "admin", secret: b64url(edit) }, parsed_as: "malformed", close: 4401 },
    { why: "unknown field", json: { join: DOC, channel: "content", extra: 1 }, parsed_as: "malformed", close: 4400 },
    { why: "unknown channel", json: { join: DOC, channel: "secrets" }, parsed_as: "malformed", close: 4400 },
    { why: "expire out of range", json: { expire: DOC, in: 0 }, parsed_as: "malformed", close: 4400 },
    { why: "expire without in", json: { expire: DOC }, parsed_as: "malformed", close: 4400 },
    { why: "verifier of 1 byte", json: { rotate: { ...verifiersJson, read: "AA" } }, parsed_as: "malformed", close: 4400 },
    { why: "two messages in one", json: { delete: DOC, expire: DOC, in: 1 }, parsed_as: "malformed", close: 4400 },
  ],
  create_document_refused: [
    { why: "no v", json: { verifiers: verifiersJson }, parsed_as: "unsupported_version" },
    { why: "missing verifier", json: { v: 1, verifiers: { read: verifiersJson.read } }, parsed_as: "malformed" },
    { why: "the fields in an array, not an object", json: [1, verifiersJson], parsed_as: "malformed" },
  ],
  server_messages: [
    {
      name: "authenticated",
      json: { authenticated: "read", generation: 1, expires_at: null, v: 1 },
      decoded: { kind: "authenticated", role: "read", generation: 1, expiresAt: null, version: 1 },
    },
    {
      name: "authenticated with expiry",
      json: { authenticated: "edit", generation: 2, expires_at: 1800000000, v: 1 },
      decoded: { kind: "authenticated", role: "edit", generation: 2, expiresAt: 1800000000, version: 1 },
    },
    {
      name: "history",
      json: {
        history: [
          { channel: "content", seq: 3, blob: b64(range(1, 5)) },
          { channel: "content", seq: 7, blob: b64(range(250, 4)) },
        ],
      },
      decoded: {
        kind: "history",
        entries: [
          { channel: "content", seq: 3, blob: hex(range(1, 5)) },
          { channel: "content", seq: 7, blob: hex(range(250, 4)) },
        ],
      },
    },
    { name: "empty history", json: { history: [] }, decoded: { kind: "history", entries: [] } },
    { name: "ack", json: { ack: "annotations", seq: 12 }, decoded: { kind: "ack", channel: "annotations", seq: 12 } },
    { name: "rotated", json: { rotated: 3 }, decoded: { kind: "rotated", generation: 3 } },
    { name: "expiry", json: { expiry: 1800000150 }, decoded: { kind: "expiry", expiresAt: 1800000150 } },
    { name: "expiry removed", json: { expiry: null }, decoded: { kind: "expiry", expiresAt: null } },
  ],
  server_messages_ignored: [
    { why: "an unknown key", json: { notice: "hello" } },
    { why: "shaped like the ack of version 0", json: { channel: "content", seq: 1 } },
    { why: "an unknown key with channel and seq", json: { receipt: "content", channel: "content", seq: 1 } },
    { why: "shaped like the expiry reply of version 0", json: { expires_at: 7 } },
    { why: "empty", json: {} },
  ],
  server_messages_with_unknown_fields: [
    { json: { ack: "content", seq: 1, at: 5 }, decoded: { kind: "ack", channel: "content", seq: 1 } },
    {
      json: { history: [{ channel: "comments", seq: 1, blob: 5 }, { channel: "content", seq: 2, blob: "AQ==" }], more: true },
      decoded: { kind: "history", entries: [{ channel: "content", seq: 2, blob: "01" }] },
    },
    {
      json: { history: [{ channel: 5, seq: 1, blob: "AQ==" }, { seq: 1 }, { channel: null, seq: 1.5, blob: "%%" }, { channel: "content", seq: 4, blob: "Ag==" }] },
      decoded: { kind: "history", entries: [{ channel: "content", seq: 4, blob: "02" }] },
    },
  ],
  server_messages_malformed: [
    { why: "two keys", json: { ack: "content", seq: 1, rotated: 4 } },
    { why: "authenticated without v", json: { authenticated: "edit", generation: 1 } },
    { why: "ack with a string seq", json: { ack: "content", seq: "1" } },
    // W-47 with W-1 and W-2 (phase 9, 9c.3).
    { why: "not an object", json: [] },
    { why: "not an object: an array of a message", json: [{ ack: "content", seq: 1 }] },
    { why: "ack with a fractional seq", json: { ack: "content", seq: 1.5 } },
    { why: "ack with a negative seq", json: { ack: "content", seq: -1 } },
    { why: "ack with a seq of 2^53", json: { ack: "content", seq: 9007199254740992 } },
    { why: "authenticated with a fractional v", json: { authenticated: "edit", generation: 1, expires_at: null, v: 1.5 } },
    { why: "authenticated without expires_at", json: { authenticated: "edit", generation: 1, v: 1 } },
    { why: "authenticated with a negative generation", json: { authenticated: "edit", generation: -1, expires_at: null, v: 1 } },
    { why: "authenticated with a fractional expiry", json: { authenticated: "edit", generation: 1, expires_at: 1.5, v: 1 } },
    { why: "rotated to a fractional generation", json: { rotated: 2.5 } },
    { why: "expiry negative", json: { expiry: -1 } },
    { why: "history entry with a fractional seq", json: { history: [{ channel: "content", seq: 1.5, blob: "AQ==" }] } },
    { why: "history entry without its base64 padding", json: { history: [{ channel: "content", seq: 1, blob: "AQ" }] } },
    { why: "history entry with whitespace in its base64", json: { history: [{ channel: "content", seq: 1, blob: "AQ==\n" }] } },
    { why: "history entry that isn't an object", json: { history: [null] } },
  ],
  frames: ["content", "annotations", "decisions", "presence"].map((channel, byte) => ({
    channel,
    byte,
    blob: hex(range(0x30 + byte, 3)),
    frame: hex(Uint8Array.of(byte, ...range(0x30 + byte, 3))),
  })),
  frames_of_unknown_channel: [hex(Uint8Array.of(9, 1, 2, 3)), hex(Uint8Array.of(255))],
  close_codes: {
    malformed: 4400,
    unauthenticated: 4401,
    forbidden: 4403,
    deleted: 4404,
    too_slow: 4408,
    revoked: 4410,
    unsupported_version: 4426,
    too_many_connections: 4429,
  },
};

// --- 3. The document ---------------------------------------------------

const suggestionPeer = (annotationId) =>
  createHash("sha256")
    .update(utf8(`obsidian-collab/suggestion/v1\0${annotationId}`))
    .digest()
    .readBigUInt64BE(0);

const content = new LoroDoc();
content.setPeerId(1n);
content.getText("content").insert(0, "hello world");
content.commit();
const contentSnapshot = content.export({ mode: "snapshot" });

/** A change made as D-16 says (or broken on purpose). */
function change(annotationId, edit, peer = suggestionPeer(annotationId)) {
  const fork = content.fork();
  fork.setPeerId(peer);
  const before = fork.oplogVersion();
  edit(fork.getText("content"));
  fork.commit();
  return fork.export({ mode: "update", from: before });
}

const additionChange = change("a1", (text) => text.insert(5, " there"));
const detached = [
  { why: "one insertion by the annotation's peer", annotation_id: "a1", change: hex(additionChange), verdict: "valid", text: " there" },
  { why: "another peer", annotation_id: "a1", change: hex(change("a1", (text) => text.insert(5, "!"), 99n)), verdict: "invalid" },
  {
    why: "two insertions",
    annotation_id: "a2",
    change: hex(change("a2", (text) => { text.insert(0, "a"); text.insert(3, "b"); })),
    verdict: "invalid",
  },
  {
    why: "two insertions, the second where the first ended: one insertion (D-17, rule 3)",
    annotation_id: "a5",
    change: hex(change("a5", (text) => { text.insert(5, "a"); text.insert(6, "b"); })),
    verdict: "valid",
    text: "ab",
  },
  {
    why: "two pieces end to end in the JSON (0, then 1), the second made after the text was imported: two states, invalid (D-17, rule 3)",
    annotation_id: "a6",
    change: hex((() => {
      // The first piece on the empty text, the second once "hello world" is in.
      const fork = content.forkAt([]);
      fork.setPeerId(suggestionPeer("a6"));
      fork.getText("content").insert(0, "X");
      fork.commit();
      fork.import(contentSnapshot);
      fork.setPeerId(suggestionPeer("a6"));
      fork.getText("content").insert(1, "Y");
      fork.commit();
      return fork.export({ mode: "update", from: content.oplogVersion() });
    })()),
    verdict: "invalid",
  },
  { why: "a deletion", annotation_id: "a3", change: hex(change("a3", (text) => text.delete(0, 5))), verdict: "invalid" },
  {
    why: "a snapshot",
    annotation_id: "a4",
    change: hex((() => {
      const fork = content.fork();
      fork.setPeerId(suggestionPeer("a4"));
      fork.getText("content").insert(0, "x");
      fork.commit();
      return fork.export({ mode: "snapshot" });
    })()),
    verdict: "invalid",
  },
  { why: "not Loro", annotation_id: "a1", change: hex(utf8("not a change")), verdict: "invalid" },
];

const annotations = new LoroDoc();
annotations.setPeerId(2n);
const cursor = (at) => content.getText("content").getCursor(at, 0).encode();
function entry(id, fields) {
  const map = annotations.getMap("annotations").setContainer(id, new LoroMap());
  for (const [field, value] of Object.entries(fields)) map.set(field, value);
  return map;
}
// D-38: replies, each element a LoroMap pushed at the end of the list; a
// plain value pushes the value itself (a malformed element, D-39).
function replies(map, elements) {
  const list = map.setContainer("replies", new LoroList());
  for (const element of elements) {
    if (element === null || typeof element !== "object" || Array.isArray(element)) {
      list.push(element);
      continue;
    }
    const reply = list.insertContainer(list.length, new LoroMap());
    for (const [field, value] of Object.entries(element)) reply.set(field, value);
  }
}
const base = { author: "alice", status: "open", createdAt: 1700000000000 };
replies(entry("c1", { ...base, type: "comment", startCursor: cursor(0), endCursor: cursor(4), endOnLastChar: true, body: "hi" }), [
  { author: "bob", createdAt: 1700000060000, body: "hello" },
  { author: "alice", createdAt: 1690000000000, body: "an earlier clock, still second", mood: "unknown field" },
]);
replies(entry("a1", { ...base, type: "addition", startCursor: cursor(5), endCursor: cursor(5), change: additionChange, note: "why", priority: "unknown field" }), [
  "not a map",
  { createdAt: 1700000001000, body: "no author" },
  { author: "bob", createdAt: "1700000001000", body: "createdAt a string" },
  { author: "bob", createdAt: 1700000001000, body: "" },
  { author: "bob", createdAt: 1700000001000, body: 7 },
  { author: "bob", createdAt: 1700000002000, body: "the only good one" },
  42,
]);
entry("d1", { ...base, type: "deletion", status: "accepted", startCursor: cursor(6), endCursor: cursor(10), endOnLastChar: true });
entry("bad-cursor", { ...base, type: "comment", startCursor: Uint8Array.of(1, 2, 3), endCursor: cursor(4), body: "x" });
entry("bad-type", { ...base, type: "highlight", startCursor: cursor(0), endCursor: cursor(4) });
entry("bad-status", { ...base, type: "deletion", status: "closed", startCursor: cursor(0), endCursor: cursor(4) });
entry("no-author", { status: "open", createdAt: 1, type: "deletion", startCursor: cursor(0), endCursor: cursor(4) });
const elsewhere = new LoroDoc();
elsewhere.setPeerId(3n); // fixed: the file is the same at every run
elsewhere.getText("notes").insert(0, "hello world");
entry("bad-container", { ...base, type: "deletion", startCursor: cursor(0), endCursor: elsewhere.getText("notes").getCursor(4, 0).encode(), endOnLastChar: true });
// D-37: a cursor Cursor.decode accepts, at counter -1 (the third byte of a
// cursor of peer 1 is its counter, a zigzag varint: 04 = 2, 01 = -1).
const trapCursor = Uint8Array.from(cursor(2));
trapCursor[2] = 0x01;
if (Cursor.decode(trapCursor).pos()?.counter !== -1) throw new Error("trap cursor: not at -1");
entry("trap-cursor", { ...base, type: "comment", startCursor: trapCursor, endCursor: cursor(4), endOnLastChar: true, body: "trap" });
// D-39: a `replies` that isn't a LoroList: read without replies.
entry("replies-map", { ...base, type: "comment", startCursor: cursor(0), endCursor: cursor(0), body: "replies is a map" })
  .setContainer("replies", new LoroMap())
  .set("0", "x");
entry("replies-value", { ...base, type: "comment", startCursor: cursor(0), endCursor: cursor(0), body: "replies is a string", replies: "hello" });
annotations.getMap("annotations").set("not-a-map", "text");
annotations.getMap("other-root").set("ignored", true);
annotations.commit();

// D-19, D-20: the history's tables, written by hand. A peer id is a
// decimal string of an unsigned 64-bit integer; a larger one is skipped.
const tables = new LoroDoc();
tables.setPeerId(5n);
const peers = tables.getMap("peers");
peers.set("1", "alice");
peers.set("18446744073709551615", "bob");
peers.set("18446744073709551616", "beyond 64 bits");
peers.set("x", "not a number");
peers.set("2", 42);
const versionsTable = tables.getMap("versions");
function version(id, fields) {
  const map = versionsTable.setContainer(id, new LoroMap());
  for (const [field, value] of Object.entries(fields)) map.set(field, value);
}
const named = { name: "draft", author: "alice", at: 1700000000000 };
version("held", { ...named, frontiers: [{ peer: "1", counter: 4 }] });
version("empty", { ...named, frontiers: [] });
version("ahead", { ...named, frontiers: [{ peer: "1", counter: 11 }] });
version("max-peer", { ...named, frontiers: [{ peer: "18446744073709551615", counter: 0 }] });
version("peer-beyond-64-bits", { ...named, frontiers: [{ peer: "18446744073709551616", counter: 0 }] });
version("negative-counter", { ...named, frontiers: [{ peer: "1", counter: -1 }] });
version("empty-name", { ...named, name: "", frontiers: [] });
versionsTable.set("not-a-map", "text");
tables.commit();

const afterDeletion = content.fork();
afterDeletion.setPeerId(4n);
afterDeletion.getText("content").delete(6, 5); // "world", d1's range
afterDeletion.commit();

const proposal = (fields) => utf8(JSON.stringify(fields));
const p = (id, annotationId, decision, extra = {}) =>
  proposal({ proposalId: id, annotationId, decision, author: "ed", ...extra });

const records = [
  { why: "minimal", plaintext: hex(p("p", "a", "reject")), valid: { proposalId: "p", annotationId: "a", decision: "reject", author: "ed" } },
  { why: "accept with a change", plaintext: hex(p("p", "a", "accept", { change: "AQID" })), valid: { proposalId: "p", annotationId: "a", decision: "accept", author: "ed", change: "010203" } },
  { why: "non-zero padding bits are ignored", plaintext: hex(p("p", "a", "accept", { change: "QR==" })), valid: { proposalId: "p", annotationId: "a", decision: "accept", author: "ed", change: "41" } },
  { why: "an empty change", plaintext: hex(p("p", "a", "accept", { change: "" })), valid: { proposalId: "p", annotationId: "a", decision: "accept", author: "ed", change: "" } },
  {
    why: "a duplicate key: the last counts",
    plaintext: hex(utf8('{"proposalId":"p","annotationId":"a","decision":"reject","author":"ed","decision":"accept"}')),
    valid: { proposalId: "p", annotationId: "a", decision: "accept", author: "ed" },
  },
  { why: "a byte-order mark", plaintext: hex(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), p("p", "a", "resolve")])), valid: { proposalId: "p", annotationId: "a", decision: "resolve", author: "ed" } },
  { why: "whitespace around", plaintext: hex(utf8(` \n${p("p", "a", "resolve")}\t `)), valid: { proposalId: "p", annotationId: "a", decision: "resolve", author: "ed" } },
  {
    why: "an escaped lone surrogate",
    plaintext: hex(utf8('{"proposalId":"p","annotationId":"a","decision":"reject","author":"\\ud800"}')),
    valid: null,
  },
  {
    why: "an escaped lone low surrogate",
    plaintext: hex(utf8('{"proposalId":"p\\udc00","annotationId":"a","decision":"reject","author":"ed"}')),
    valid: null,
  },
  {
    why: "an escaped lone surrogate in an unknown field",
    plaintext: hex(utf8('{"proposalId":"p","annotationId":"a","decision":"reject","author":"ed","x":"\\ud800"}')),
    valid: null,
  },
  {
    why: "an escaped lone surrogate in a key",
    plaintext: hex(utf8('{"proposalId":"p","annotationId":"a","decision":"reject","author":"ed","\\udc00":1}')),
    valid: null,
  },
  {
    why: "an escaped lone surrogate in a value a duplicate key overrides",
    plaintext: hex(utf8('{"proposalId":"p","annotationId":"a","decision":"reject","author":"\\ud800","author":"ed"}')),
    valid: null,
  },
  {
    why: "an escaped backslash before u: not an escape of a surrogate",
    plaintext: hex(utf8('{"proposalId":"p","annotationId":"a","decision":"reject","author":"\\\\ud800"}')),
    valid: { proposalId: "p", annotationId: "a", decision: "reject", author: "\\ud800" },
  },
  {
    why: "an escaped surrogate pair",
    plaintext: hex(utf8('{"proposalId":"p","annotationId":"a","decision":"reject","author":"\\ud83d\\ude00"}')),
    valid: { proposalId: "p", annotationId: "a", decision: "reject", author: "\u{1f600}" },
  },
  { why: "an unknown field", plaintext: hex(p("p", "a", "reject", { reason: "x" })), valid: { proposalId: "p", annotationId: "a", decision: "reject", author: "ed" } },
  { why: "empty strings", plaintext: hex(proposal({ proposalId: "", annotationId: "", decision: "reject", author: "" })), valid: { proposalId: "", annotationId: "", decision: "reject", author: "" } },
  { why: "invalid UTF-8", plaintext: hex(Buffer.concat([utf8('{"proposalId":"p","annotationId":"a","decision":"reject","author":"'), Buffer.from([0xff]), utf8('"}')])), valid: null },
  { why: "a change of null", plaintext: hex(p("p", "a", "accept", { change: null })), valid: null },
  { why: "a change on a reject", plaintext: hex(p("p", "a", "reject", { change: "AQID" })), valid: null },
  { why: "a change of bad length", plaintext: hex(p("p", "a", "accept", { change: "QR=" })), valid: null },
  { why: "a change in base64url", plaintext: hex(p("p", "a", "accept", { change: "-_-_" })), valid: null },
  { why: "an unknown decision", plaintext: hex(p("p", "a", "approve")), valid: null },
  { why: "no author", plaintext: hex(proposal({ proposalId: "p", annotationId: "a", decision: "reject" })), valid: null },
  { why: "a number id", plaintext: hex(proposal({ proposalId: 1, annotationId: "a", decision: "reject", author: "ed" })), valid: null },
  { why: "an array", plaintext: hex(utf8("[]")), valid: null },
  { why: "empty (a blob that didn't decrypt)", plaintext: "", valid: null },
];

const accept = (id, annotationId, bytes) => p(id, annotationId, "accept", { change: b64(bytes) });
const winners = {
  why: "first of each class wins; a later acceptance of the same operations, or of bytes that aren't Loro, is void",
  journal: [
    { seq: 1, plaintext: hex(accept("p1", "a1", additionChange)) },
    { seq: 2, plaintext: hex(accept("p2", "a9", additionChange)) },
    { seq: 4, plaintext: hex(p("p3", "a1", "reject")) },
    { seq: 5, plaintext: hex(accept("p4", "a3", utf8("not a change"))) },
    { seq: 6, plaintext: hex(p("p5", "c1", "resolve")) },
    { seq: 8, plaintext: hex(p("p6", "c1", "resolve")) },
    { seq: 9, plaintext: "" },
    { seq: 11, plaintext: hex(p("p7", "c1", "accept")) },
    { seq: 12, plaintext: hex(p("p8", "d1", "reject")) },
    { seq: 13, plaintext: hex(p("p9", "d1", "accept")) },
    {
      seq: 14,
      plaintext: hex(accept("p10", "a5", (() => {
        const fork = content.fork();
        fork.setPeerId(suggestionPeer("a5"));
        fork.getText("content").insert(0, "x");
        fork.commit();
        return fork.export({ mode: "snapshot" });
      })())),
    },
  ],
  suggestions: { a1: { proposalId: "p1", void: false }, a9: { proposalId: "p2", void: true }, a3: { proposalId: "p4", void: true }, c1: { proposalId: "p7", void: false }, d1: { proposalId: "p8", void: false }, a5: { proposalId: "p10", void: true } },
  comments: { c1: { proposalId: "p5" } },
};

const presenceCases = [
  { why: "a state", state: { v: 1, key: "0123456789abcdef0123456789abcdef", seq: 1, name: "alice", color: "#d1495b" }, shown: true },
  { why: "a state with unknown fields", state: { v: 1, key: "0123456789abcdef0123456789abcdef", seq: 3, name: "", color: "#000000", mood: "ok" }, shown: true },
  { why: "a departure", state: { v: 1, key: "0123456789abcdef0123456789abcdef", seq: 2, gone: true }, shown: false },
  { why: "version 2", state: { v: 2, key: "0123456789abcdef0123456789abcdef", seq: 1, name: "a", color: "#d1495b" }, shown: false },
  { why: "an uppercase key", state: { v: 1, key: "0123456789ABCDEF0123456789ABCDEF", seq: 1, name: "a", color: "#d1495b" }, shown: false },
  { why: "seq 0", state: { v: 1, key: "0123456789abcdef0123456789abcdef", seq: 0, name: "a", color: "#d1495b" }, shown: false },
  { why: "seq 1.5", state: { v: 1, key: "0123456789abcdef0123456789abcdef", seq: 1.5, name: "a", color: "#d1495b" }, shown: false },
  { why: "a name of 201 units", state: { v: 1, key: "0123456789abcdef0123456789abcdef", seq: 1, name: "n".repeat(201), color: "#d1495b" }, shown: false },
  { why: "an uppercase color", state: { v: 1, key: "0123456789abcdef0123456789abcdef", seq: 1, name: "a", color: "#D1495B" }, shown: false },
  { why: "an anchor not base64", state: { v: 1, key: "0123456789abcdef0123456789abcdef", seq: 1, name: "a", color: "#d1495b", anchor: "%%" }, shown: false },
  {
    why: "an anchor that decodes but names counter -1: shown, never resolved (D-37)",
    state: { v: 1, key: "0123456789abcdef0123456789abcdef", seq: 1, name: "a", color: "#d1495b", anchor: Buffer.from(trapCursor).toString("base64") },
    shown: true,
    anchor_resolved: false,
  },
  { why: "an anchor in base64 without its padding (a length not a multiple of 4)", state: { v: 1, key: "0123456789abcdef0123456789abcdef", seq: 1, name: "a", color: "#d1495b", anchor: "AQ" }, shown: false },
].map(({ state, ...rest }) => ({ ...rest, plaintext: hex(utf8(JSON.stringify(state))) }));
// D-32: JSON text is UTF-8 (RFC 8259); a state that isn't is ignored.
presenceCases.push({
  why: "not UTF-8: a name with the byte FF",
  shown: false,
  plaintext: hex(Buffer.concat([utf8('{"v":1,"key":"0123456789abcdef0123456789abcdef","seq":1,"name":"a'), Buffer.from([0xff]), utf8('","color":"#d1495b"}')])),
});

const document = {
  loro_crdt: "1.16.3",
  content_snapshot: hex(contentSnapshot),
  content_text: "hello world",
  suggestion_peers: ["a1", "b2f6c1e0-7d6a-4c9e-9a51-2f3c4d5e6f70", "é"].map((id) => ({ annotation_id: id, peer: suggestionPeer(id).toString() })),
  annotations: {
    snapshot: hex(annotations.export({ mode: "snapshot" })),
    note: "Each valid entry's own fields (the stored status, not the one derived from decisions, D-29) with its resolved range; in no particular order.",
    listed: [
      { id: "c1", type: "comment", author: "alice", status: "open", createdAt: 1700000000000, body: "hi", range: { start: 0, end: 5 } },
      { id: "d1", type: "deletion", author: "alice", status: "accepted", createdAt: 1700000000000, range: { start: 6, end: 11 } },
      { id: "a1", type: "addition", author: "alice", status: "open", createdAt: 1700000000000, change: hex(additionChange), note: "why", range: { start: 5, end: 5 } },
      { id: "trap-cursor", type: "comment", author: "alice", status: "open", createdAt: 1700000000000, body: "trap", range: null },
      { id: "replies-map", type: "comment", author: "alice", status: "open", createdAt: 1700000000000, body: "replies is a map", range: { start: 0, end: 0 } },
      { id: "replies-value", type: "comment", author: "alice", status: "open", createdAt: 1700000000000, body: "replies is a string", range: { start: 0, end: 0 } },
    ],
    replies_note: "D-38, D-39: the replies of each listed entry, in the list's order, malformed elements skipped, unknown fields dropped; none when the entry has no replies or they aren't a LoroList.",
    replies: {
      c1: [
        { author: "bob", createdAt: 1700000060000, body: "hello" },
        { author: "alice", createdAt: 1690000000000, body: "an earlier clock, still second" },
      ],
      d1: [],
      a1: [{ author: "bob", createdAt: 1700000002000, body: "the only good one" }],
      "trap-cursor": [],
      "replies-map": [],
      "replies-value": [],
    },
  },
  annotations_after_deletion: {
    why: "d1's characters deleted: its range is zero-width where it was (D-13)",
    content_snapshot: hex(afterDeletion.export({ mode: "snapshot" })),
    ranges: { c1: { start: 0, end: 5 }, d1: { start: 6, end: 6 }, a1: { start: 5, end: 5 }, "trap-cursor": null, "replies-map": { start: 0, end: 0 }, "replies-value": { start: 0, end: 0 } },
  },
  history_tables: {
    why: "D-19, D-20: well-formed entries only; a version is available when the content snapshot holds its frontiers",
    snapshot: hex(tables.export({ mode: "snapshot" })),
    peers: { 1: "alice", "18446744073709551615": "bob" },
    versions: [
      { id: "ahead", ...named, frontiers: [{ peer: "1", counter: 11 }], available: false },
      { id: "empty", ...named, frontiers: [], available: true },
      { id: "held", ...named, frontiers: [{ peer: "1", counter: 4 }], available: true },
      { id: "max-peer", ...named, frontiers: [{ peer: "18446744073709551615", counter: 0 }], available: false },
    ],
  },
  detached_changes: detached,
  decision_records: records,
  decision_winners: winners,
  presence: presenceCases,
};

// --- 5. The keyring ----------------------------------------------------

const keyringSecret = range(0x51, 32);
const KEYRING_ID = "0123456789abcdef0123456789abcdef";
const keyringKey = range(0x71, 32);
const keyringLink = `oc-keyring:v1:${KEYRING_ID}.${b64url(keyringSecret)}.${b64url(keyringKey)}`;
// A document's links in the keyring: a secret per (document, role, n),
// never the same for two (KR-20 keys links by their secret).
const kSecret = (doc, role, n = 0) => {
  const secret = range(0x40, 32);
  secret.set(utf8(doc).subarray(0, 8), 0);
  secret[8] = ["read", "suggest", "edit"].indexOf(role);
  secret[9] = n;
  return secret;
};
const kLink = (doc, role, n = 0) =>
  `https://collab.example.org/?doc=${doc}#k=${b64url(range(0xa0, 32))}&r=${role}.${b64url(kSecret(doc, role, n))}`;
const keyringDoc = new LoroDoc();
keyringDoc.setPeerId(7n);
{
  const m = (name) => keyringDoc.getMap(name);
  // KR-20: a link under its own secret, and when it was last accepted.
  const put = (doc, role, n = 0, seen) => {
    m("links").set(b64url(kSecret(doc, role, n)), kLink(doc, role, n));
    if (seen !== undefined) m("seen").set(b64url(kSecret(doc, role, n)), seen);
  };
  const refuse = (doc, role, n = 0, names = doc) => m("failed").set(b64url(kSecret(doc, role, n)), names);
  m("meta").set("v", 1);
  put("d1", "edit", 0, 1792159267000);
  m("title").set("d1", "Plan de route");
  m("opened").set("d1", 1792159267897);
  m("created").set("d1", true);
  put("d2", "read");
  put("d2", "edit");
  refuse("d2", "edit");
  put("d3", "suggest");
  put("d3", "read");
  refuse("d3", "suggest");
  refuse("d3", "read");
  put("d4", "edit");
  refuse("d4", "edit");
  m("deleted").set("d4", 1792159300000);
  // d5: a link under another link's secret.
  m("links").set(b64url(kSecret("d1", "read")), kLink("d5", "edit"));
  put("d6", "edit");
  m("title").set("d6", 42);
  m("opened").set("d6", "yesterday");
  m("created").set("d6", "yes");
  m("links").set(b64url(kSecret("d7", "edit")), "https://collab.example.org/?doc=d7");
  put("d7", "read");
  put("d8", "edit");
  refuse("d8", "edit", 0, "other");
  put("d9", "read");
  m("excluded").set("d9", 1792159400000);
  // d10: three edit links, the newest accepted is current; one never seen.
  put("d10", "edit", 0, 100);
  put("d10", "edit", 1, 200);
  put("d10", "edit", 2);
  m("seen").set(b64url(kSecret("d10", "edit", 2)), "later");
  // d11: two edit links seen at the same time: the smaller secret first.
  put("d11", "edit", 0, 300);
  put("d11", "edit", 1, 300);
  // d12: a link that would run something when opened (KR-21).
  m("links").set(b64url(kSecret("d12", "edit")), kLink("d12", "edit").replace("https://collab.example.org/", "javascript:alert(1)//"));
  m("future").set("d1", "something a later client writes");
  keyringDoc.commit();
}
const keyringSnapshot = keyringDoc.export({ mode: "snapshot" });
const keyringNonce = range(0x30, 12);
const keyringCipher = createCipheriv("aes-256-gcm", keyringKey, keyringNonce);
const keyringBlob = Buffer.concat([
  keyringNonce,
  keyringCipher.update(keyringSnapshot),
  keyringCipher.final(),
  keyringCipher.getAuthTag(),
]);
const keyringTampered = Buffer.from(keyringBlob);
keyringTampered[20] ^= 1;
// KR-46: the other keys its person signed with, written from the
// specification; the expected list by hand.
const ownKeyA = range(0x21, 32);
const ownKeyB = range(0x41, 32);
const ownKeysDoc = new LoroDoc();
ownKeysDoc.setPeerId(8n);
{
  const keys = ownKeysDoc.getMap("keys");
  ownKeysDoc.getMap("meta").set("v", 1);
  keys.set(b64url(ownKeyA), 1792159267000);
  keys.set(b64url(ownKeyB), 1792159300000);
  keys.set(b64url(range(0x61, 31)), 1792159300000); // 31 bytes
  keys.set(b64url(Buffer.from("0100000000000000000000000000000000000000000000000000000000000000", "hex")), 1); // small order (ID-6)
  keys.set(b64url(range(0x81, 32)), "yesterday"); // not an integer
  keys.set(b64url(range(0xa1, 32)), 1.5); // not an integer
  keys.set("not base64url!", 1);
  ownKeysDoc.commit();
}
const keyring = {
  verifiers: [
    { secret: hex(keyringSecret), verifier: hex(verifier("keyring", keyringSecret)) },
    {
      secret: hex(new Uint8Array(32).fill(0x42)),
      verifier: hex(verifier("keyring", new Uint8Array(32).fill(0x42))),
    },
  ],
  // KR-5: the expected statuses written from the specification.
  create_keyring: { v: 1, verifier: b64url(verifier("keyring", keyringSecret)) },
  create_keyring_refused: [
    { why: "no v", json: { verifier: b64url(verifier("keyring", keyringSecret)) }, status: 426 },
    { why: "v 2", json: { v: 2, verifier: b64url(verifier("keyring", keyringSecret)) }, status: 426 },
    { why: "v as text", json: { v: "1", verifier: b64url(verifier("keyring", keyringSecret)) }, status: 426 },
    { why: "no verifier", json: { v: 1 }, status: 400 },
    { why: "verifier of 31 bytes", json: { v: 1, verifier: b64url(range(0, 31)) }, status: 400 },
    { why: "verifier of 33 bytes", json: { v: 1, verifier: b64url(range(0, 33)) }, status: 400 },
    { why: "padded verifier", json: { v: 1, verifier: `${b64url(range(0, 32))}=` }, status: 400 },
    { why: "standard alphabet", json: { v: 1, verifier: Buffer.from(range(0xf8, 32)).toString("base64").replace(/=+$/, "") }, status: 400 },
    { why: "unknown field", json: { v: 1, verifier: b64url(range(0, 32)), extra: true }, status: 400 },
    { why: "not an object", json: [1], status: 400 },
    { why: "the fields in an array, not an object", json: [1, b64url(verifier("keyring", keyringSecret))], status: 400 },
  ],
  // KR-4: what `Keyring-Secret` holds; anything else is refused (404).
  secret_headers: [{ header: b64url(keyringSecret), secret: hex(keyringSecret) }],
  secret_headers_refused: [
    { why: "31 bytes", header: b64url(range(0x51, 31)) },
    { why: "33 bytes", header: b64url(range(0x51, 33)) },
    { why: "padded", header: `${b64url(keyringSecret)}=` },
    { why: "standard alphabet", header: Buffer.from(range(0xf8, 32)).toString("base64").replace(/=+$/, "") },
    { why: "empty", header: "" },
    { why: "space around", header: ` ${b64url(keyringSecret)}` },
  ],
  // KR-3, KR-7: the entity tags of a version; anything else never matches.
  entity_tags: [
    { version: 0, tag: '"0"' },
    { version: 17, tag: '"17"' },
    { version: 2 ** 53 - 1, tag: `"${2 ** 53 - 1}"` },
  ],
  if_match_never_matching: ["*", '"1", "2"', 'W/"1"', "1", '"01"', '"-1"', '"1.0"', '""', `"${2 ** 53}"`, '" 1"'],
  // KR-16: keyring links read, and refused.
  links: [
    { link: keyringLink, keyring_id: KEYRING_ID, secret: hex(keyringSecret), key: hex(keyringKey) },
    { why: "white space around", link: ` \n${keyringLink}\t`, keyring_id: KEYRING_ID, secret: hex(keyringSecret), key: hex(keyringKey) },
  ],
  links_refused: [
    { why: "another version", link: keyringLink.replace("oc-keyring:v1:", "oc-keyring:v2:") },
    { why: "no prefix", link: keyringLink.replace("oc-keyring:v1:", "") },
    { why: "a part missing", link: `oc-keyring:v1:${KEYRING_ID}.${b64url(keyringSecret)}` },
    { why: "a part in excess", link: `${keyringLink}.${b64url(keyringKey)}` },
    { why: "uppercase id", link: keyringLink.replace(KEYRING_ID, KEYRING_ID.toUpperCase()) },
    { why: "key of 31 bytes", link: `oc-keyring:v1:${KEYRING_ID}.${b64url(keyringSecret)}.${b64url(keyringKey.slice(0, 31))}` },
    { why: "padded secret", link: `oc-keyring:v1:${KEYRING_ID}.${b64url(keyringSecret)}=.${b64url(keyringKey)}` },
    { why: "standard alphabet", link: `oc-keyring:v1:${KEYRING_ID}.${b64url(keyringSecret)}.${Buffer.from(range(0xf8, 32)).toString("base64").replace(/=+$/, "")}` },
    { why: "a space inside", link: keyringLink.replace(".", " .") },
    { why: "a document link", link: `https://collab.example.org/?doc=${KEYRING_ID}#k=${b64url(keyringKey)}&r=edit.${b64url(keyringSecret)}` },
  ],
  // KR-18: a blob, and one that doesn't decrypt (KR-19).
  blobs: [{ key: hex(keyringKey), nonce: hex(keyringNonce), plaintext: hex(keyringSnapshot), blob: hex(keyringBlob) }],
  blobs_that_dont_decrypt: [hex(keyringTampered)],
  // KR-20 – KR-22: what a keyring lists, written from the specification.
  documents: {
    snapshot: hex(keyringSnapshot),
    why: "d1 ok; d2 edit refused, read current; d3 every link refused: renewed, shown its suggest link; d4 deleted, though refused too; d5 a link under another's secret: not listed; d6 fields of another type ignored; d7 a malformed link, the read link current; d8 a refusal naming another document: ignored; d9 excluded; d10 the newest accepted edit link current; d11 seen at the same time: the smaller secret first; d12 a javascript: link, not listed; an unknown root map ignored",
    entries: [
      { document_id: "d1", state: "ok", role: "edit", link: kLink("d1", "edit"), title: "Plan de route", opened_at: 1792159267897, created_here: true, excluded: false },
      { document_id: "d10", state: "ok", role: "edit", link: kLink("d10", "edit", 1), title: null, opened_at: null, created_here: false, excluded: false },
      { document_id: "d11", state: "ok", role: "edit", link: [kLink("d11", "edit", 0), kLink("d11", "edit", 1)].sort((x, y) => (x.split(".").pop() < y.split(".").pop() ? -1 : 1))[0], title: null, opened_at: null, created_here: false, excluded: false },
      { document_id: "d2", state: "ok", role: "read", link: kLink("d2", "read"), title: null, opened_at: null, created_here: false, excluded: false },
      { document_id: "d3", state: "renewed", role: "suggest", link: kLink("d3", "suggest"), title: null, opened_at: null, created_here: false, excluded: false },
      { document_id: "d4", state: "deleted", role: "edit", link: kLink("d4", "edit"), title: null, opened_at: null, created_here: false, excluded: false },
      { document_id: "d6", state: "ok", role: "edit", link: kLink("d6", "edit"), title: null, opened_at: null, created_here: false, excluded: false },
      { document_id: "d7", state: "ok", role: "read", link: kLink("d7", "read"), title: null, opened_at: null, created_here: false, excluded: false },
      { document_id: "d8", state: "ok", role: "edit", link: kLink("d8", "edit"), title: null, opened_at: null, created_here: false, excluded: false },
      { document_id: "d9", state: "ok", role: "read", link: kLink("d9", "read"), title: null, opened_at: null, created_here: false, excluded: true },
    ],
  },
  // KR-46: the keys listed, in no particular order.
  own_keys: {
    snapshot: hex(ownKeysDoc.export({ mode: "snapshot" })),
    why: "two keys under integers; a key of 31 bytes, a point of small order, values that aren't integers, a name that isn't base64url: ignored",
    keys: [hex(ownKeyA), hex(ownKeyB)],
  },
  keyring_ids: ["0123456789abcdef0123456789abcdef"],
  keyring_ids_refused: ["0123456789ABCDEF0123456789ABCDEF", "0123456789abcdef0123456789abcde", "0123456789abcdef0123456789abcdef0", "../keyrings", "0123456789abcdef0123456789abcdeg"],
};

// --- 5.10 Adding a device: deposits and pairing addresses -------------
const pairingKey = range(0x91, 32);
const PAIRING_ID = "fedcba9876543210fedcba9876543210";
const seal = (text, nonceStart) => {
  const nonce = range(nonceStart, 12);
  const cipher = createCipheriv("aes-256-gcm", pairingKey, nonce);
  const plaintext = typeof text === "string" ? Buffer.from(text, "utf8") : Buffer.from(text);
  return Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
};
const sealedLink = seal(JSON.stringify({ v: 1, keyring: keyringLink }), 0x10);
const sealedTampered = Buffer.from(sealedLink);
sealedTampered[sealedTampered.length - 1] ^= 1;
keyring.pairing = {
  // KR-34, KR-36: deposits read, under the pairing key `key`.
  key: hex(pairingKey),
  deposits: [
    { why: "the form of KR-34", plaintext: JSON.stringify({ v: 1, keyring: keyringLink }), deposit: hex(sealedLink), keyring_id: KEYRING_ID, secret: hex(keyringSecret), link_key: hex(keyringKey) },
    { why: "another member, ignored", plaintext: JSON.stringify({ keyring: keyringLink, v: 1, from: "laptop" }), deposit: hex(seal(JSON.stringify({ keyring: keyringLink, v: 1, from: "laptop" }), 0x20)), keyring_id: KEYRING_ID, secret: hex(keyringSecret), link_key: hex(keyringKey) },
    { why: "white space around the link (KR-16)", plaintext: JSON.stringify({ v: 1, keyring: ` ${keyringLink}\n` }), deposit: hex(seal(JSON.stringify({ v: 1, keyring: ` ${keyringLink}\n` }), 0x28)), keyring_id: KEYRING_ID, secret: hex(keyringSecret), link_key: hex(keyringKey) },
  ],
  deposits_refused: [
    { why: "tag altered", deposit: hex(sealedTampered) },
    { why: "under another key", deposit: hex((() => { const nonce = range(0x30, 12); const c = createCipheriv("aes-256-gcm", range(0x92, 32), nonce); return Buffer.concat([nonce, c.update(JSON.stringify({ v: 1, keyring: keyringLink })), c.final(), c.getAuthTag()]); })()) },
    { why: "shorter than a nonce and a tag", deposit: hex(range(0, 27)) },
    { why: "v 2", deposit: hex(seal(JSON.stringify({ v: 2, keyring: keyringLink }), 0x38)) },
    { why: "v as text", deposit: hex(seal(JSON.stringify({ v: "1", keyring: keyringLink }), 0x40)) },
    { why: "no v", deposit: hex(seal(JSON.stringify({ keyring: keyringLink }), 0x48)) },
    { why: "no keyring", deposit: hex(seal(JSON.stringify({ v: 1 }), 0x50)) },
    { why: "a malformed keyring link", deposit: hex(seal(JSON.stringify({ v: 1, keyring: keyringLink.replace("v1", "v2") }), 0x58)) },
    { why: "a keyring that isn't text", deposit: hex(seal(JSON.stringify({ v: 1, keyring: [keyringLink] }), 0x60)) },
    { why: "an array", deposit: hex(seal(JSON.stringify([1, keyringLink]), 0x68)) },
    { why: "the link alone, as text", deposit: hex(seal(keyringLink, 0x70)) },
    { why: "not UTF-8", deposit: hex(seal([0x7b, 0x22, 0x76, 0x22, 0x3a, 0x31, 0xff, 0x7d], 0x78)) },
  ],
  // KR-35: pairing addresses read, refused, or naming no pairing.
  addresses: [
    { address: `https://collab.example.org/?pair=${PAIRING_ID}#p=${b64url(pairingKey)}`, pairing_id: PAIRING_ID, key: hex(pairingKey) },
    { why: "non-zero padding bits ignored (D-24)", address: `https://collab.example.org/?pair=${PAIRING_ID}#p=${b64url(pairingKey).slice(0, -1)}${String.fromCharCode(b64url(pairingKey).charCodeAt(42) + 1)}`, pairing_id: PAIRING_ID, key: hex(pairingKey) },
  ],
  addresses_refused: [
    { why: "uppercase id", address: `https://collab.example.org/?pair=${PAIRING_ID.toUpperCase()}#p=${b64url(pairingKey)}` },
    { why: "pair twice", address: `https://collab.example.org/?pair=${PAIRING_ID}&pair=${PAIRING_ID}#p=${b64url(pairingKey)}` },
    { why: "no fragment", address: `https://collab.example.org/?pair=${PAIRING_ID}` },
    { why: "a key of 31 bytes", address: `https://collab.example.org/?pair=${PAIRING_ID}#p=${b64url(pairingKey.slice(0, 31))}` },
    { why: "padded key", address: `https://collab.example.org/?pair=${PAIRING_ID}#p=${b64url(pairingKey).slice(0, 42)}=` },
    { why: "more in the fragment", address: `https://collab.example.org/?pair=${PAIRING_ID}#p=${b64url(pairingKey)}&x=1` },
    { why: "another name", address: `https://collab.example.org/?pair=${PAIRING_ID}#k=${b64url(pairingKey)}` },
  ],
  not_pairing_addresses: [
    "https://collab.example.org/",
    `https://collab.example.org/?doc=${PAIRING_ID}#p=${b64url(pairingKey)}`,
  ],
};
// KR-43: none of these names an account.
for (const entry of keyring.pairing.addresses) entry.account = false;

// --- 5.12 The keyring of an account: its key, deposits, addresses -------
const accountKey = range(0xa1, 32);
const accountKeyText = `oc-keyring:v1:${b64url(accountKey)}`;
// The last character with its padding bits set (D-24).
const lastBitsSet = (text) => `${text.slice(0, -1)}${String.fromCharCode(text.charCodeAt(text.length - 1) + 1)}`;
const sealAccount = (value, nonceStart) => seal(typeof value === "string" ? value : JSON.stringify(value), nonceStart);
const pairAddress = (query, fragment = `p=${b64url(pairingKey)}`) => `https://collab.example.org/?${query}#${fragment}`;
keyring.account = {
  // KR-42: an account's key read, and refused.
  keys: [
    { key: accountKeyText, value: hex(accountKey) },
    { why: "white space around", key: `\t${accountKeyText} \n`, value: hex(accountKey) },
    { why: "non-zero padding bits ignored (D-24)", key: lastBitsSet(accountKeyText), value: hex(accountKey) },
  ],
  keys_refused: [
    { why: "a keyring link, three parts", key: keyringLink },
    { why: "two parts", key: `${accountKeyText}.${b64url(accountKey)}` },
    { why: "another version", key: accountKeyText.replace("oc-keyring:v1:", "oc-keyring:v2:") },
    { why: "no prefix", key: b64url(accountKey) },
    { why: "a key of 31 bytes", key: `oc-keyring:v1:${b64url(accountKey.slice(0, 31))}` },
    { why: "a key of 33 bytes", key: `oc-keyring:v1:${b64url(Buffer.concat([accountKey, Buffer.from([1])]))}` },
    { why: "padded", key: `${accountKeyText}=` },
    { why: "standard base64", key: `oc-keyring:v1:${Buffer.from(accountKey).toString("base64").replace(/=+$/, "")}` },
    { why: "nothing after the prefix", key: "oc-keyring:v1:" },
  ],
  // KR-43: deposits of an account, under the pairing key of §5.10.
  deposits: [
    { why: "the form of KR-43", deposit: hex(sealAccount({ v: 1, key: b64url(accountKey) }, 0x80)), value: hex(accountKey) },
    { why: "another member, ignored", deposit: hex(sealAccount({ key: b64url(accountKey), v: 1, from: "phone" }, 0x88)), value: hex(accountKey) },
  ],
  deposits_refused: [
    { why: "a keyring link instead of a key", deposit: hex(sealAccount({ v: 1, keyring: keyringLink }, 0x90)) },
    { why: "the key as an account's key text", deposit: hex(sealAccount({ v: 1, key: accountKeyText }, 0x98)) },
    { why: "a key of 31 bytes", deposit: hex(sealAccount({ v: 1, key: b64url(accountKey.slice(0, 31)) }, 0xa0)) },
    { why: "a padded key", deposit: hex(sealAccount({ v: 1, key: `${b64url(accountKey)}=` }, 0xa8)) },
    { why: "a key that isn't text", deposit: hex(sealAccount({ v: 1, key: [...accountKey] }, 0xb0)) },
    { why: "v 2", deposit: hex(sealAccount({ v: 2, key: b64url(accountKey) }, 0xb8)) },
    { why: "no key", deposit: hex(sealAccount({ v: 1 }, 0xc0)) },
    { why: "an array", deposit: hex(sealAccount([1, b64url(accountKey)], 0xc8)) },
    { why: "tag altered", deposit: hex((() => { const d = sealAccount({ v: 1, key: b64url(accountKey) }, 0xd0); d[d.length - 1] ^= 1; return d; })()) },
  ],
  // KR-43: pairing addresses of an account, read and refused.
  addresses: [
    { address: pairAddress(`pair=${PAIRING_ID}&account`), pairing_id: PAIRING_ID, key: hex(pairingKey), account: true },
    { why: "account first", address: pairAddress(`account&pair=${PAIRING_ID}`), pairing_id: PAIRING_ID, key: hex(pairingKey), account: true },
    { why: "an empty value", address: pairAddress(`pair=${PAIRING_ID}&account=`), pairing_id: PAIRING_ID, key: hex(pairingKey), account: true },
  ],
  addresses_refused: [
    { why: "account twice", address: pairAddress(`pair=${PAIRING_ID}&account&account`) },
    { why: "account with a value", address: pairAddress(`pair=${PAIRING_ID}&account=1`) },
    { why: "account without its key", address: `https://collab.example.org/?pair=${PAIRING_ID}&account` },
  ],
};

// --- 6. Identity: signatures -------------------------------------------
// Deterministic CBOR (ID-1 – ID-3), written here again, without the
// client's code: a value is a boolean, a safe integer, a string, a Buffer
// (bytes) or a plain object.
function cbor(value) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 2 ** 8) return Buffer.from([(major << 5) | 24, n]);
    if (n < 2 ** 16) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
    if (n < 2 ** 32) { const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b; }
    const b = Buffer.alloc(9); b[0] = (major << 5) | 27; b.writeBigUInt64BE(BigInt(n), 1); return b;
  };
  if (value === true) return Buffer.from([0xf5]);
  if (value === false) return Buffer.from([0xf4]);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("not encodable");
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value === "string") {
    if (!value.isWellFormed()) throw new Error("lone surrogate");
    const b = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, b.length), b]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  const pairs = Object.entries(value)
    .map(([k, v]) => [cbor(k), cbor(v)])
    .sort(([a], [b]) => Buffer.compare(a, b));
  return Buffer.concat([head(5, pairs.length), ...pairs.flat()]);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest();
const edKey = (seed) =>
  createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seed)]),
    format: "der",
    type: "pkcs8",
  });
const rawPublic = (privateKey) =>
  createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(12);

const idSeed = range(0xa1, 32);
const idPrivate = edKey(idSeed);
const idPublic = rawPublic(idPrivate);
const idFingerprint = sha256(idPublic);
const otherSeed = range(0xc1, 32);
const otherPublic = rawPublic(edKey(otherSeed));
const ID_DOC = "6f1d0c2a9b3e4f5a8c7d6e5f4a3b2c1d";

// The message of §6.5, from an object's fields as the vectors give them:
// bytes as hex under `<name>_hex`, hashed where the table says so.
function idMessage(kind, documentId, id, fields, signer) {
  const own = {};
  for (const [name, value] of Object.entries(fields)) {
    if (name === "change_hex") own.change = sha256(Buffer.from(value, "hex"));
    else if (name === "frontiers") own.frontiers = value.map((f) => `${f.peer}@${f.counter}`).join(",");
    else own[name] = value;
  }
  return cbor({ ...own, ctx: "oc-sig/v1", kind, doc: documentId, id, signer });
}
const idSign = (message, privateKey = idPrivate) =>
  Buffer.concat([idFingerprint.subarray(0, 8), edSign(null, message, privateKey)]);

const idObjects = [
  { kind: "annotation", id: "0b7e2c58-4a1f-4c3e-9d2b-7f6a5e4d3c2b", fields: { type: "comment", author: "Alice", createdAt: 1792159267897, body: "Plutôt « demain » — 😀" } },
  { kind: "annotation", id: "5d2c1b0a-9e8f-4a7b-8c6d-5e4f3a2b1c0d", fields: { type: "substitution", author: "Alice", createdAt: 1792159267898, note: "plus clair", change_hex: "0102030405" } },
  { kind: "reply", id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", fields: { annotation: "0b7e2c58-4a1f-4c3e-9d2b-7f6a5e4d3c2b", author: "Alice", createdAt: 1792159300000, body: "D'accord." } },
  { kind: "decision", id: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f", fields: { annotation: "5d2c1b0a-9e8f-4a7b-8c6d-5e4f3a2b1c0d", decision: "accept", author: "Alice", change_hex: "0102030405" } },
  { kind: "decision", id: "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a", fields: { annotation: "0b7e2c58-4a1f-4c3e-9d2b-7f6a5e4d3c2b", decision: "resolve", author: "Alice" } },
  { kind: "version", id: "3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b", fields: { name: "Relue", author: "Alice", at: 1792159400000, frontiers: [{ peer: "12345678901234567890", counter: 41 }, { peer: "7", counter: 0 }] } },
  { kind: "version", id: "4f5a6b7c-8d9e-4f0a-9b1c-3d4e5f6a7b8c", fields: { name: "Vide", author: "", at: -1, frontiers: [] } },
  { kind: "peer", id: "18446744073709551615", fields: { name: "Alice" } },
  { kind: "presence", id: "0123456789abcdef0123456789abcdef", fields: { seq: 1, name: "Alice", color: "#d1495b" } },
].map((o) => {
  const message = idMessage(o.kind, ID_DOC, o.id, o.fields, idFingerprint);
  return { ...o, message: hex(message), sig: hex(idSign(message)) };
});

// What must come out unverified, each with why (ID-6, ID-7, ID-14 – ID-16).
const first = idObjects[0];
const firstSig = Buffer.from(first.sig, "hex");
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const withS = (sig, add) => {
  const out = Buffer.from(sig);
  let s = 0n;
  for (let i = 71; i >= 40; i--) s = (s << 8n) | BigInt(out[i]);
  s += add;
  for (let i = 40; i < 72; i++) { out[i] = Number(s & 0xffn); s >>= 8n; }
  return out;
};
const smallOrder = Buffer.from("0100000000000000000000000000000000000000000000000000000000000000", "hex");
const smallOrderFingerprint = sha256(smallOrder);
// R = the neutral point, S = 0: the bare equation holds for this key.
const smallOrderSig = Buffer.concat([smallOrderFingerprint.subarray(0, 8), smallOrder, Buffer.alloc(32)]);
const idUnverified = [
  { why: "a signed field changed", ...first, fields: { ...first.fields, author: "Bob" } },
  { why: "another document", ...first, document_id: "7f2e1d3b0c4a5f6b9d8e7f6a5b4c3d2e" },
  { why: "another object", ...first, id: "0b7e2c58-4a1f-4c3e-9d2b-7f6a5e4d3c2c" },
  { why: "another kind (the same fields as a reply)", ...idObjects[2], kind: "annotation", fields: { type: "comment", author: "Alice", createdAt: 1792159300000, body: "D'accord." }, sig: idObjects[2].sig },
  { why: "S not below L", ...first, sig: hex(withS(firstSig, L)) },
  { why: "sig of 71 bytes", ...first, sig: hex(firstSig.subarray(0, 71)) },
  { why: "another short fingerprint", ...first, sig: hex(Buffer.concat([sha256(otherPublic).subarray(0, 8), firstSig.subarray(8)])) },
  { why: "createdAt not an integer", ...first, fields: { ...first.fields, createdAt: 1792159267897.5 } },
  { why: "a text with a lone surrogate", ...first, fields: { ...Object.fromEntries(Object.entries(first.fields).filter(([n]) => n !== "body")), body_utf16: "d800" } },
  { why: "a key of small order, whose bare equation holds", ...first, public_key: hex(smallOrder), sig: hex(smallOrderSig) },
  { why: "no key known", ...first, public_key: null },
];

const identity = {
  comment:
    "docs/protocol/06-identity.md. Objects of `objects` are signed by `key` in document `document_id`: a client finds them signed (ID-15) by that key; those of `unverified` are not (ID-16), with the key `public_key` when given (null: no key known). Fields as an object holds them; `<name>_hex` are bytes, `<name>_utf16` a text given as its UTF-16 code units in hex (four digits each: a lone surrogate, which JSON parsers in some languages refuse). Signatures were made by Node (deterministic); a client verifies them, never compares its own.",
  key: { seed: hex(idSeed), public_key: hex(idPublic), fingerprint: hex(idFingerprint), short: (hex(idFingerprint).slice(0, 16).match(/.{4}/g) ?? []).join(" ") },
  document_id: ID_DOC,
  encoding: [
    { value: 0, cbor: "00" },
    { value: 24, cbor: "1818" },
    { value: -25, cbor: "3818" },
    { value: 9007199254740991, cbor: "1b001fffffffffffff" },
    { value: "ü", cbor: "62c3bc" },
    { value: { aa: 1, b: 2, a: 3 }, cbor: "a3616103616202626161" + "01" },
    { value: true, cbor: "f5" },
  ],
  objects: idObjects.map(({ kind, id, fields, message, sig }) => ({ kind, id, fields, message, sig })),
  unverified: idUnverified.map(({ why, kind, id, fields, sig, document_id, public_key }) => ({
    why, kind, id, fields, sig,
    document_id: document_id ?? ID_DOC,
    public_key: public_key === undefined ? hex(idPublic) : public_key,
  })),
  keys_refused: [
    { why: "neutral point", public_key: hex(smallOrder) },
    { why: "neutral point, sign bit set", public_key: "0100000000000000000000000000000000000000000000000000000000000080" },
    { why: "order 2", public_key: "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f" },
    { why: "order 4", public_key: "0000000000000000000000000000000000000000000000000000000000000000" },
    { why: "order 8", public_key: "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05" },
    { why: "order 8", public_key: "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a" },
    { why: "non-canonical y = p", public_key: "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f" },
    { why: "non-canonical y = p + 18", public_key: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f" },
  ],
  // ID-8: an `identities` map, and the fingerprints a client reads from it.
  identities: {
    entries: [
      { name: hex(idFingerprint), value: hex(idPublic) },
      { name: hex(sha256(otherPublic)), value: hex(idPublic) },
      { name: hex(sha256(smallOrder)), value: hex(smallOrder) },
      { name: hex(sha256(otherPublic.subarray(0, 31))), value: hex(otherPublic.subarray(0, 31)) },
      { name: hex(sha256(otherPublic)).toUpperCase(), value: hex(otherPublic) },
    ],
    read: [hex(idFingerprint)],
  },
};

// --- 6.7 The gateway: signing in -----------------------------------------
// The forms of ID-19, ID-21, ID-22; expected outcomes written from the
// specification.
const gwVerifier = range(0xd1, 32);
const gwChallenge = b64url(createHash("sha256").update(gwVerifier).digest());
const gwCode = b64url(range(0xe1, 32));
const gwRequest = "0123456789abcdef0123456789abcdef";
identity.gateway = {
  verifier: b64url(gwVerifier),
  challenge: gwChallenge,
  login_queries: [{ request: gwRequest, challenge: gwChallenge }],
  login_queries_refused: [
    { why: "uppercase request", request: gwRequest.toUpperCase(), challenge: gwChallenge },
    { why: "request of 31 characters", request: gwRequest.slice(1), challenge: gwChallenge },
    { why: "no request", request: null, challenge: gwChallenge },
    { why: "no challenge", request: gwRequest, challenge: null },
    { why: "padded challenge", request: gwRequest, challenge: `${gwChallenge}=` },
    { why: "challenge of 31 bytes", request: gwRequest, challenge: b64url(range(0, 31)) },
  ],
  session_bodies: [{ json: { code: gwCode, verifier: b64url(gwVerifier) } }],
  session_bodies_refused: [
    { why: "no verifier", json: { code: gwCode } },
    { why: "an unknown field", json: { code: gwCode, verifier: b64url(gwVerifier), more: 1 } },
    { why: "a verifier of 31 bytes", json: { code: gwCode, verifier: b64url(range(0, 31)) } },
    { why: "the fields in an array", json: [gwCode, b64url(gwVerifier)] },
    { why: "a code that isn't text", json: { code: 7, verifier: b64url(gwVerifier) } },
  ],
  // ID-25: the return in the fragment of /auth-return, as a client reads it.
  returns: [
    { hash: `#code=${gwCode}&request=${gwRequest}`, expected: { request: gwRequest, code: gwCode } },
    { hash: `#request=${gwRequest}&code=${gwCode}`, expected: { request: gwRequest, code: gwCode } },
    { hash: `#error=denied&request=${gwRequest}`, expected: { request: gwRequest, error: "denied" } },
    { hash: `#error=failed&request=${gwRequest}`, expected: { request: gwRequest, error: "failed" } },
    { hash: `#error=temporarily_unavailable&request=${gwRequest}`, expected: { request: gwRequest, error: "failed" } },
  ],
  returns_refused: [
    { why: "no fragment", hash: "" },
    { why: "no request", hash: `#code=${gwCode}` },
    { why: "no code", hash: `#request=${gwRequest}` },
    { why: "a code and an error", hash: `#code=${gwCode}&error=denied&request=${gwRequest}` },
    { why: "the code twice", hash: `#code=${gwCode}&code=${gwCode}&request=${gwRequest}` },
    { why: "another field", hash: `#code=${gwCode}&request=${gwRequest}&x=1` },
    { why: "an uppercase request", hash: `#code=${gwCode}&request=${gwRequest.toUpperCase()}` },
    { why: "a padded code", hash: `#code=${gwCode}=&request=${gwRequest}` },
    { why: "a code of 31 bytes", hash: `#code=${b64url(range(0, 31))}&request=${gwRequest}` },
    { why: "a code encoded otherwise", hash: `#code=${gwCode.slice(0, 42)}B&request=${gwRequest}` },
    { why: "an escaped request", hash: `#code=${gwCode}&request=%30${gwRequest.slice(1)}` },
    { why: "a query, not a fragment", hash: `?code=${gwCode}&request=${gwRequest}` },
  ],
  // ID-41: the login's raw query, as the gateway reads its `client`.
  login_clients: [
    { query: `request=${gwRequest}&challenge=${gwChallenge}`, client: "page" },
    { query: `request=${gwRequest}&challenge=${gwChallenge}&client=obsidian`, client: "obsidian" },
    { query: `client=obsidian&request=${gwRequest}&challenge=${gwChallenge}&fresh`, client: "obsidian" },
  ],
  login_clients_refused: [
    { why: "another client", query: `request=${gwRequest}&challenge=${gwChallenge}&client=page` },
    { why: "an empty client", query: `request=${gwRequest}&challenge=${gwChallenge}&client=` },
    { why: "a client without a value", query: `request=${gwRequest}&challenge=${gwChallenge}&client` },
    { why: "client twice", query: `request=${gwRequest}&challenge=${gwChallenge}&client=obsidian&client=obsidian` },
    { why: "an uppercase client", query: `request=${gwRequest}&challenge=${gwChallenge}&client=Obsidian` },
    { why: "an escaped client", query: `request=${gwRequest}&challenge=${gwChallenge}&client=obsidia%6E` },
  ],
  // ID-41: the parameters Obsidian hands the plugin's handler, decoded.
  obsidian_returns: [
    { params: { action: "collab-link-auth", code: gwCode, request: gwRequest }, expected: { request: gwRequest, code: gwCode } },
    { params: { action: "collab-link-auth", error: "denied", request: gwRequest }, expected: { request: gwRequest, error: "denied" } },
    { params: { action: "collab-link-auth", error: "access_denied", request: gwRequest }, expected: { request: gwRequest, error: "failed" } },
  ],
  obsidian_returns_refused: [
    { why: "another action", params: { action: "open", code: gwCode, request: gwRequest } },
    { why: "no action", params: { code: gwCode, request: gwRequest } },
    { why: "a hash", params: { action: "collab-link-auth", hash: `code=${gwCode}&request=${gwRequest}` } },
    { why: "a hash beside the return", params: { action: "collab-link-auth", code: gwCode, request: gwRequest, hash: "" } },
    { why: "no request", params: { action: "collab-link-auth", code: gwCode } },
    { why: "a code and an error", params: { action: "collab-link-auth", code: gwCode, error: "denied", request: gwRequest } },
    { why: "an uppercase request", params: { action: "collab-link-auth", code: gwCode, request: gwRequest.toUpperCase() } },
    { why: "a padded code", params: { action: "collab-link-auth", code: `${gwCode}=`, request: gwRequest } },
    { why: "a code that isn't text", params: { action: "collab-link-auth", code: 7, request: gwRequest } },
  ],
  // ID-21, ID-24, ID-25: a session answer.
  sessions: [
    {
      json: { token: gwCode, expires_at: 1800043200, name: "Ada", email: "ada@example.org", issuer: "https://idp.example", sub: "u-1" },
      expected: { token: gwCode, expires_at: 1800043200, name: "Ada", email: "ada@example.org", issuer: "https://idp.example", sub: "u-1" },
    },
    {
      json: { token: gwCode, expires_at: 0, name: "", email: null, issuer: "i", sub: "s", more: [1] },
      expected: { token: gwCode, expires_at: 0, name: "", email: null, issuer: "i", sub: "s" },
    },
  ],
  sessions_refused: [
    { why: "no sub", json: { token: gwCode, expires_at: 1, name: "Ada", email: null, issuer: "i" } },
    { why: "no issuer", json: { token: gwCode, expires_at: 1, name: "Ada", email: null, sub: "s" } },
    { why: "no email", json: { token: gwCode, expires_at: 1, name: "Ada", issuer: "i", sub: "s" } },
    { why: "an expiry as text", json: { token: gwCode, expires_at: "1", name: "Ada", email: null, issuer: "i", sub: "s" } },
    { why: "a token of 31 bytes", json: { token: b64url(range(0, 31)), expires_at: 1, name: "Ada", email: null, issuer: "i", sub: "s" } },
    { why: "a name that isn't text", json: { token: gwCode, expires_at: 1, name: null, email: null, issuer: "i", sub: "s" } },
    { why: "an array", json: [gwCode, 1] },
  ],
  bearers: [`Bearer ${gwCode}`],
  bearers_refused: [`bearer ${gwCode}`, `Bearer  ${gwCode}`, gwCode, `Bearer ${gwCode}=`, "Bearer "],
};

// --- 6.8 The gateway: keys and attestations --------------------------------
// The gateway's attestation key and the person's (`identity.key`), fixed:
// Ed25519 is deterministic, a gateway reproduces each envelope to the byte.
const attSeed = range(0x51, 32);
const attPrivate = edKey(attSeed);
const attPublic = rawPublic(attPrivate);
const envelope = (message) => cbor({ key: attPublic, msg: message, sig: edSign(null, message, attPrivate) });
const DAYS_30 = 2592000;
const attestationMessage = ({ issuer, sub, name, email, issuedAt }) =>
  cbor({
    ctx: "oc-attestation/v1",
    issuer,
    sub,
    name,
    ...(email === undefined ? {} : { email }),
    key: idPublic,
    issuedAt,
    expiresAt: issuedAt + DAYS_30,
  });
const attested = [
  { issuer: "https://idp.example.org/realms/acme", sub: "248289761001", name: "Ada Lovelace", email: "ada@example.org", issuedAt: 1792159267 },
  { issuer: "https://idp.example.org/realms/acme", sub: "248289761002", name: "Émile", issuedAt: 1792160000 },
];
const proofMessage = (issuer, sub, key) => cbor({ ctx: "oc-key-proof/v1", issuer, sub, key });
const proofIssuer = attested[0].issuer;
const proofSub = attested[0].sub;
const goodProof = edSign(null, proofMessage(proofIssuer, proofSub, idPublic), idPrivate);
const otherPrivate = edKey(otherSeed);
identity.attestation = {
  gateway_key: { seed: hex(attSeed), public_key: hex(attPublic), fingerprint: hex(sha256(attPublic)) },
  // `key` of each attestation is `identity.key.public_key`.
  attestations: attested.map((fields) => {
    const message = attestationMessage(fields);
    return { fields, expires_at: fields.issuedAt + DAYS_30, message: hex(message), envelope: hex(envelope(message)) };
  }),
  proofs: [
    {
      issuer: proofIssuer,
      sub: proofSub,
      key: hex(idPublic),
      message: hex(proofMessage(proofIssuer, proofSub, idPublic)),
      proof: hex(goodProof),
    },
  ],
  // ID-29: each refused for the account (proofIssuer, proofSub).
  proofs_refused: [
    { why: "made for another account", key: hex(idPublic), proof: hex(edSign(null, proofMessage(proofIssuer, "248289761002", idPublic), idPrivate)) },
    { why: "signed by another key", key: hex(idPublic), proof: hex(edSign(null, proofMessage(proofIssuer, proofSub, idPublic), otherPrivate)) },
    { why: "another context", key: hex(idPublic), proof: hex(edSign(null, cbor({ ctx: "oc-sig/v1", issuer: proofIssuer, sub: proofSub, key: idPublic }), idPrivate)) },
    { why: "S not below L", key: hex(idPublic), proof: hex(withS(Buffer.concat([Buffer.alloc(8), goodProof]), L).subarray(8)) },
    { why: "a key of small order", key: hex(smallOrder), proof: hex(Buffer.concat([smallOrder, Buffer.alloc(32)])) },
  ],
  key_bodies: [{ json: { key: b64url(idPublic), proof: b64url(goodProof) } }],
  key_bodies_refused: [
    { why: "no proof", json: { key: b64url(idPublic) } },
    { why: "a key of 31 bytes", json: { key: b64url(idPublic.subarray(0, 31)), proof: b64url(goodProof) } },
    { why: "a padded proof", json: { key: b64url(idPublic), proof: `${b64url(goodProof)}==` } },
    { why: "an unknown field", json: { key: b64url(idPublic), proof: b64url(goodProof), more: 1 } },
    { why: "the fields in an array", json: [b64url(idPublic), b64url(goodProof)] },
  ],
  attestation_bodies: [{ json: { key: b64url(idPublic) } }],
  attestation_bodies_refused: [
    { why: "no key", json: {} },
    { why: "a key of 33 bytes", json: { key: b64url(Buffer.concat([idPublic, Buffer.alloc(1)])) } },
    { why: "an unknown field", json: { key: b64url(idPublic), more: 1 } },
  ],
};

// --- 6.9 The gateway: revocations --------------------------------------
// Signed by the gateway's attestation key of 6.8; the revoked keys are
// `identity.key` and the other key of `identity`.
const revocationMessage = ({ issuedAt, revoked }) => cbor({ ctx: "oc-revocations/v1", issuedAt, revoked });
const revocationLists = [
  { issuedAt: 1792159267, revoked: {} },
  {
    issuedAt: 1792160000,
    revoked: { [hex(idFingerprint)]: 1792159300, [hex(sha256(otherPublic))]: 1792159999 },
  },
];
const pushSecret = range(0x71, 32);
const listB64 = b64url(envelope(revocationMessage(revocationLists[1])));
identity.revocations = {
  lists: revocationLists.map((fields) => {
    const message = revocationMessage(fields);
    return { fields, message: hex(message), envelope: hex(envelope(message)) };
  }),
  // ID-33: the secret of `Revocations-Secret` and its verifier (K-8).
  push_secret: { header: b64url(pushSecret), secret: hex(pushSecret), verifier: hex(verifier("revocations", pushSecret)) },
  push_secret_headers_refused: [
    { why: "31 bytes", header: b64url(range(0x71, 31)) },
    { why: "padded", header: `${b64url(pushSecret)}=` },
    { why: "empty", header: "" },
    { why: "another secret", header: b64url(range(0x72, 32)) },
  ],
  // ID-33, ID-34: bodies the server reads, and those it refuses (400).
  push_bodies: [
    { text: JSON.stringify({ issuedAt: 1792160000, list: listB64 }), issued_at: 1792160000, list: hex(Buffer.from(listB64, "base64url")) },
    { text: JSON.stringify({ list: "AA", issuedAt: 2 ** 53 - 1 }), issued_at: 2 ** 53 - 1, list: "00" },
    { text: JSON.stringify({ issuedAt: 0, list: "AA" }), issued_at: 0, list: "00" },
  ],
  push_bodies_refused: [
    { why: "no list", text: JSON.stringify({ issuedAt: 1 }) },
    { why: "no issuedAt", text: JSON.stringify({ list: listB64 }) },
    { why: "an issuedAt as text", text: JSON.stringify({ issuedAt: "1", list: "AA" }) },
    { why: "a negative issuedAt", text: JSON.stringify({ issuedAt: -1, list: "AA" }) },
    { why: "an issuedAt of 2^53", text: `{"issuedAt":${2 ** 53},"list":"AA"}` },
    { why: "a fractional issuedAt", text: '{"issuedAt":1.5,"list":"AA"}' },
    { why: "an empty list", text: JSON.stringify({ issuedAt: 1, list: "" }) },
    { why: "a padded list", text: JSON.stringify({ issuedAt: 1, list: "AA==" }) },
    { why: "the standard alphabet", text: JSON.stringify({ issuedAt: 1, list: "+/8" }) },
    { why: "an unknown field", text: JSON.stringify({ issuedAt: 1, list: "AA", more: 1 }) },
    { why: "the fields in an array", text: JSON.stringify([1, "AA"]) },
    { why: "not JSON", text: "issuedAt=1" },
  ],
};

// --- 6.10 Attested names -----------------------------------------------
// Entries of `attestations` and revocation lists as a client reads them
// (ID-36, ID-37, ID-40): the configured fingerprint is that of the
// gateway's key of 6.8. Each refused one has one flaw, the rest made well
// (signed by the gateway's key unless the flaw is the signature).
const otherGateway = edKey(range(0x61, 32));
const signedBy = (key, message) =>
  cbor({ key: rawPublic(key), msg: message, sig: edSign(null, message, key) });
// A map in the order given, without sorting: for non-canonical forms.
const rawMap = (pairs) => {
  const head = Buffer.from([0xa0 | pairs.length]);
  return Buffer.concat([head, ...pairs.flatMap(([k, v]) => [cbor(k), v])]);
};
const goodFields = attested[0];
const attestationOf = (fields) => ({
  ctx: "oc-attestation/v1",
  issuer: goodFields.issuer,
  sub: goodFields.sub,
  name: goodFields.name,
  email: goodFields.email,
  key: idPublic,
  issuedAt: goodFields.issuedAt,
  expiresAt: goodFields.issuedAt + DAYS_30,
  ...fields,
});
const attEntry = (value) => ({ key: hex(sha256(value)), value: hex(value) });
const goodMessage = attestationMessage(goodFields);
const goodEnvelope = envelope(goodMessage);
const goodSig = edSign(null, goodMessage, attPrivate);
const without = (object, name) => {
  const { [name]: _, ...rest } = object;
  return rest;
};
identity.attestations = {
  configured: [hex(sha256(attPublic))],
  entries: attested.map((fields) => {
    const value = envelope(attestationMessage(fields));
    return {
      ...attEntry(value),
      attestation: { ...fields, key: hex(idPublic), expiresAt: fields.issuedAt + DAYS_30 },
    };
  }),
  entries_refused: [
    { why: "a key that isn't the value's digest", key: hex(sha256(Buffer.from("other"))), value: hex(goodEnvelope) },
    { why: "an attestation key not configured", ...attEntry(signedBy(otherGateway, goodMessage)) },
    { why: "a signature that doesn't verify", ...attEntry(cbor({ key: attPublic, msg: goodMessage, sig: Buffer.from(goodSig).map((b, i) => (i === 0 ? b ^ 1 : b)) })) },
    { why: "the envelope's keys out of order", ...attEntry(rawMap([["sig", cbor(goodSig)], ["key", cbor(attPublic)], ["msg", cbor(goodMessage)]])) },
    { why: "a key repeated", ...attEntry(rawMap([["key", cbor(attPublic)], ["key", cbor(attPublic)], ["msg", cbor(goodMessage)], ["sig", cbor(goodSig)]])) },
    { why: "a byte left over", ...attEntry(Buffer.concat([goodEnvelope, Buffer.from([0])])) },
    { why: "an indefinite-length map", ...attEntry(Buffer.concat([Buffer.from([0xbf]), goodEnvelope.subarray(1), Buffer.from([0xff])])) },
    { why: "a length not in its shortest form", ...attEntry(Buffer.concat([Buffer.from([0xa3, 0x78, 0x03]), Buffer.from("key"), goodEnvelope.subarray(5)])) },
    {
      why: "a message whose date is not in its shortest form",
      ...attEntry(
        envelope(
          (() => {
            const canonicalHex = hex(goodMessage);
            const four = Buffer.alloc(4);
            four.writeUInt32BE(goodFields.issuedAt);
            const wide = canonicalHex.replace(`1a${hex(four)}`, `1b00000000${hex(four)}`);
            if (wide === canonicalHex) throw new Error("issuedAt not found");
            return Buffer.from(wide, "hex");
          })(),
        ),
      ),
    },
    { why: "an envelope field more", ...attEntry(cbor({ key: attPublic, msg: goodMessage, sig: goodSig, v: 1 })) },
    { why: "a message of another context", ...attEntry(envelope(cbor(attestationOf({ ctx: "oc-attestation/v2" })))) },
    { why: "a message field more", ...attEntry(envelope(cbor(attestationOf({ more: true })))) },
    { why: "a message without name", ...attEntry(envelope(cbor(without(attestationOf({}), "name")))) },
    { why: "an expiry not after the issue", ...attEntry(envelope(cbor(attestationOf({ expiresAt: goodFields.issuedAt })))) },
    { why: "an issue date as text", ...attEntry(envelope(cbor(attestationOf({ issuedAt: String(goodFields.issuedAt) })))) },
    { why: "a negative issue date", ...attEntry(envelope(cbor(attestationOf({ issuedAt: -1 })))) },
    { why: "an attested key of small order", ...attEntry(envelope(cbor(attestationOf({ key: smallOrder })))) },
    { why: "an attested key of 31 bytes", ...attEntry(envelope(cbor(attestationOf({ key: idPublic.subarray(0, 31) })))) },
    { why: "an email that is bytes", ...attEntry(envelope(cbor(attestationOf({ email: Buffer.from("ada@example.org") })))) },
    { why: "a message that isn't a map", ...attEntry(envelope(cbor("oc-attestation/v1"))) },
  ],
  // ID-39, for the first entry: an object's date (ms) against its
  // validity and a revocation of its key (Unix seconds, or null).
  verdicts: (() => {
    const issued = goodFields.issuedAt;
    const expires = issued + DAYS_30;
    return [
      { date: issued * 1000 - 1, revoked_at: null, attested: false },
      { date: issued * 1000, revoked_at: null, attested: true },
      { date: expires * 1000 - 1, revoked_at: null, attested: true },
      { date: expires * 1000, revoked_at: null, attested: false },
      { date: (issued + 100) * 1000 - 1, revoked_at: issued + 100, attested: true },
      { date: (issued + 100) * 1000, revoked_at: issued + 100, attested: false },
      { date: issued * 1000, revoked_at: issued, attested: false },
    ];
  })(),
  // ID-40: bodies of `GET /revocations` read, and refused.
  revocation_bodies: revocationLists.map((fields) => ({
    text: JSON.stringify({ issuedAt: fields.issuedAt, list: b64url(envelope(revocationMessage(fields))) }),
    issued_at: fields.issuedAt,
    revoked: fields.revoked,
  })),
  revocation_bodies_refused: [
    { why: "signed by a key not configured", text: JSON.stringify({ issuedAt: 1, list: b64url(signedBy(otherGateway, revocationMessage(revocationLists[1]))) }) },
    { why: "another context", text: JSON.stringify({ issuedAt: 1, list: b64url(envelope(cbor({ ctx: "oc-attestation/v1", issuedAt: 1, revoked: {} }))) }) },
    { why: "a revocation date as text", text: JSON.stringify({ issuedAt: 1, list: b64url(envelope(cbor({ ctx: "oc-revocations/v1", issuedAt: 1, revoked: { [hex(idFingerprint)]: "1" } }))) }) },
    { why: "a fingerprint in uppercase", text: JSON.stringify({ issuedAt: 1, list: b64url(envelope(cbor({ ctx: "oc-revocations/v1", issuedAt: 1, revoked: { [hex(idFingerprint).toUpperCase()]: 1 } }))) }) },
    { why: "a fingerprint of 31 bytes", text: JSON.stringify({ issuedAt: 1, list: b64url(envelope(cbor({ ctx: "oc-revocations/v1", issuedAt: 1, revoked: { [hex(idFingerprint).slice(2)]: 1 } }))) }) },
    { why: "a list without revoked", text: JSON.stringify({ issuedAt: 1, list: b64url(envelope(cbor({ ctx: "oc-revocations/v1", issuedAt: 1 }))) }) },
    { why: "a padded list", text: JSON.stringify({ issuedAt: 1, list: `${b64url(envelope(revocationMessage(revocationLists[0])))}=` }) },
    { why: "a body that is an array", text: JSON.stringify([1, b64url(envelope(revocationMessage(revocationLists[0])))]) },
    { why: "not JSON", text: "revoked" },
  ],
};

// --- 1.12 Attached images (W-53, W-54), K-19, D-40 ---------------------

const attachmentAad = (documentId, attachmentId) =>
  Buffer.concat([
    utf8("obsidian-collab/attachment/v1"),
    Uint8Array.of(0),
    utf8(documentId),
    Uint8Array.of(0),
    utf8(attachmentId),
  ]);
const encryptAttachment = (nonce, plaintext, documentId, attachmentId) => {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(attachmentAad(documentId, attachmentId));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
};
const IMAGE_ID = b64url(range(0x00, 16));
const OTHER_IMAGE_ID = b64url(range(0x10, 16));
const pngBytes = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), range(0x00, 8)]);
const imageNonce = range(0x40, 12);
const imageBlob = encryptAttachment(imageNonce, pngBytes, DOC, IMAGE_ID);
const attachment = {
  // W-53: 16 bytes in base64url, 22 characters, the last one's unused bits zero.
  ids: [IMAGE_ID, b64url(new Uint8Array(16).fill(0xff)), b64url(range(0xf0, 16))],
  ids_refused: [
    { why: "15 bytes", id: b64url(range(0x00, 15)) },
    { why: "17 bytes", id: b64url(range(0x00, 17)) },
    { why: "unused bits not zero", id: `${IMAGE_ID.slice(0, 21)}B` },
    { why: "padded", id: `${IMAGE_ID}==` },
    { why: "standard alphabet", id: Buffer.from(new Uint8Array(16).fill(0xfb)).toString("base64").replace(/=+$/, "") },
    { why: "a path", id: ".." },
    { why: "empty", id: "" },
  ],
  // W-54: the role and its secret, as `r` in a link (K-2) writes them.
  role_secret_headers: ["read", "suggest", "edit"].map((role) => ({
    header: `${role}.${b64url(secrets[role])}`,
    role,
    secret: hex(secrets[role]),
  })),
  role_secret_headers_refused: [
    { why: "no role", header: b64url(edit) },
    { why: "unknown role", header: `admin.${b64url(edit)}` },
    { why: "role in capitals", header: `Edit.${b64url(edit)}` },
    { why: "31 bytes", header: `edit.${b64url(edit.slice(1))}` },
    { why: "33 bytes", header: `edit.${b64url(range(0x01, 33))}` },
    { why: "padded", header: `edit.${b64url(edit)}=` },
    { why: "unused bits not zero", header: `edit.${b64url(edit).slice(0, 42)}B` },
    { why: "space around", header: ` edit.${b64url(edit)}` },
    { why: "two dots", header: `edit.${b64url(edit)}.x` },
    { why: "empty", header: "" },
  ],
  // K-19: under the content key of `keys`, the document and image named.
  blobs: [
    {
      document_id: DOC,
      attachment_id: IMAGE_ID,
      nonce: hex(imageNonce),
      plaintext: hex(pngBytes),
      blob: hex(imageBlob),
    },
  ],
  blobs_that_dont_decrypt: [
    { why: "fetched under another image", document_id: DOC, attachment_id: OTHER_IMAGE_ID, blob: hex(imageBlob) },
    { why: "fetched under another document", document_id: "fedcba9876543210fedcba9876543210", attachment_id: IMAGE_ID, blob: hex(imageBlob) },
    { why: "encrypted without associated data (K-10)", document_id: DOC, attachment_id: IMAGE_ID, blob: hex(encrypt(imageNonce, pngBytes)) },
  ],
  // D-40: what an image is, by its bytes alone; `null`, not shown.
  formats: [
    { why: "PNG", bytes: hex(pngBytes), format: "png" },
    { why: "JPEG", bytes: "ffd8ffe000104a464946", format: "jpeg" },
    { why: "GIF 87a", bytes: hex(utf8("GIF87a\x01\x00")), format: "gif" },
    { why: "GIF 89a", bytes: hex(utf8("GIF89a")), format: "gif" },
    { why: "WebP", bytes: hex(Buffer.concat([utf8("RIFF"), range(0x10, 4), utf8("WEBPVP8 ")])), format: "webp" },
    { why: "AVIF", bytes: hex(Buffer.concat([Uint8Array.of(0, 0, 0, 0x1c), utf8("ftypavif"), range(0, 4)])), format: "avif" },
    { why: "AVIF sequence", bytes: hex(Buffer.concat([Uint8Array.of(0, 0, 0, 0x1c), utf8("ftypavis")])), format: "avif" },
    { why: "SVG", bytes: hex(utf8('<svg xmlns="http://www.w3.org/2000/svg"/>')), format: "svg" },
    { why: "SVG after a BOM, a declaration, a comment and a doctype", bytes: hex(Buffer.concat([Buffer.from("efbbbf", "hex"), utf8('<?xml version="1.0"?>\n<!-- drawn -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n  <svg\nwidth="1">')])), format: "svg" },
    { why: "SVG closed at once", bytes: hex(utf8("<svg>")), format: "svg" },
    { why: "an element named svgx", bytes: hex(utf8("<svgx>")), format: null },
    { why: "HTML", bytes: hex(utf8("<!doctype html><svg>")), format: null },
    { why: "another element first", bytes: hex(utf8("<html><svg></svg></html>")), format: null },
    { why: "an unclosed comment", bytes: hex(utf8("<!-- <svg>")), format: null },
    { why: "PNG cut short", bytes: "89504e470d0a1a", format: null },
    { why: "WebP without its mark", bytes: hex(Buffer.concat([utf8("RIFF"), range(0x10, 4), utf8("WAVE")])), format: null },
    { why: "an MP4", bytes: hex(Buffer.concat([Uint8Array.of(0, 0, 0, 0x1c), utf8("ftypisom")])), format: null },
    { why: "BMP", bytes: hex(utf8("BM")), format: null },
    { why: "PDF", bytes: hex(utf8("%PDF-1.7")), format: null },
    { why: "empty", bytes: "", format: null },
  ],
};

// --- 1.13 Notifications (W-59 – W-65), K-20, D-41 – D-44 --------------

// P-256 key pairs from fixed private keys (node:crypto's ECDH), points in
// the 65-byte uncompressed form of SEC 1.
const p256 = (privateKey) => {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(privateKey));
  return ecdh;
};
const vapidPair = p256(range(0x31, 32));
const vapidPublic = vapidPair.getPublicKey();
const uaPair = p256(range(0x51, 32));
const uaPublic = uaPair.getPublicKey();
const uaAuth = range(0x71, 16);
const ENDPOINT = "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABqProbe";

// K-20, RFC 8291 §3.4 and RFC 8188 §2, from node:crypto alone.
function webPushEncrypt(plaintext, uaKey, auth, asPrivateKey, salt, padTo) {
  const as = p256(asPrivateKey);
  const asKey = as.getPublicKey();
  const secret = as.computeSecret(uaKey);
  const hk = (s, ikm, info, n) => Buffer.from(hkdfSync("sha256", ikm, s, info, n));
  const ikm = hk(auth, secret, Buffer.concat([utf8("WebPush: info\0"), uaKey, asKey]), 32);
  const cek = hk(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hk(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);
  const record = Buffer.concat([plaintext, Buffer.from([2])]);
  const padded = padTo === undefined ? record : Buffer.concat([record, Buffer.alloc(padTo - record.length)]);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  Buffer.from(salt).copy(header);
  header.writeUInt32BE(4096, 16);
  header[20] = 65;
  return Buffer.concat([header, asKey, body]);
}

// D-41: an entry's key is the digest of its endpoint; its message, §6.5.
const subscriptionKey = (endpoint) => hex(sha256(utf8(endpoint)));
const subscriptionMessage = (key, fields) =>
  cbor({
    ctx: "oc-sig/v1",
    kind: "subscription",
    doc: ID_DOC,
    id: key,
    signer: idFingerprint,
    endpoint: fields.endpoint,
    p256dh: Buffer.from(fields.p256dh_hex, "hex"),
    auth: Buffer.from(fields.auth_hex, "hex"),
    vapid: Buffer.from(fields.vapid_hex, "hex"),
    createdAt: fields.createdAt,
  });
const subscriptionFields = {
  endpoint: ENDPOINT,
  p256dh_hex: hex(uaPublic),
  auth_hex: hex(uaAuth),
  vapid_hex: hex(sha256(vapidPublic)),
  createdAt: 1795019510000,
};
const signedSubscription = (fields, key = subscriptionKey(fields.endpoint)) => {
  const message = subscriptionMessage(key, fields);
  return { key, fields, message: hex(message), sig: hex(idSign(message)) };
};
const goodSubscription = signedSubscription(subscriptionFields);
const longEndpoint = `https://fcm.googleapis.com/fcm/send/${"a".repeat(1024 - 36 + 1)}`;
const ignoredSubscription = (why, change) => ({ why, ...goodSubscription, ...change });

// D-43: texts as a sender writes them, by hand; `_utf16`: UTF-16 code
// units in hex, for a lone surrogate.
const messageTexts = [
  { why: "a control character becomes a space", field: "excerpt", input: "a\nb\tc\u0085d", output: "a b c d" },
  { why: "shortened to 200 code units", field: "excerpt", input: "é".repeat(250), output: "é".repeat(200) },
  { why: "a pair across the limit is dropped whole", field: "excerpt", input: `${"a".repeat(199)}😀b`, output: "a".repeat(199) },
  { why: "a pair inside the limit is kept", field: "excerpt", input: `${"a".repeat(198)}😀b`, output: `${"a".repeat(198)}😀` },
  { why: "a lone surrogate becomes U+FFFD", field: "name", input_utf16: "0041d8000042", output: "A�B" },
  { why: "a name shortened to 64", field: "name", input: "n".repeat(65), output: "n".repeat(64) },
  { why: "a title shortened to 100", field: "title", input: "t".repeat(101), output: "t".repeat(100) },
];
const notification = (fields) => JSON.stringify({ v: 1, kind: "reply", doc: ID_DOC, annotation: "0b7e2c58-4a1f-4c3e-9d2b-7f6a5e4d3c2b", title: "Compte rendu", name: "Alice", excerpt: "D'accord.", ...fields });
const notificationMessage = notification({});

// W-61: a well-formed payload, and the ways one isn't.
const goodPayload = webPushEncrypt(utf8(notificationMessage), uaPublic, uaAuth, range(0x91, 32), range(0xb1, 16), 2048);
const withByte = (bytes, at, value) => { const out = Buffer.from(bytes); out[at] = value; return out; };
const withRs = (bytes, rs) => { const out = Buffer.from(bytes); out.writeUInt32BE(rs, 16); return out; };
// RFC 8291 §5, its example's payload, copied by hand.
const rfcPayload = Buffer.from("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN", "base64url");
const pushBody = (fields) => JSON.stringify({ endpoint: ENDPOINT, ttl: 259200, payload: b64url(goodPayload), ...fields });

const push = {
  comment:
    "docs/protocol/01-wire.md §1.13, 02-links-and-encryption.md K-20, 03-document.md §3.11. Subscriptions are signed by identity.key in identity.document_id (ID-15). `<name>_hex` are bytes; `<name>_utf16` a text as its UTF-16 code units in hex. Expected outcomes written by hand from the specification; the RFC 8291 example is that of RFC 8291 §5, copied by hand.",
  vapid: { private_key: hex(range(0x31, 32)), public_key: hex(vapidPublic), fingerprint: hex(sha256(vapidPublic)) },
  // K-20 — RFC 8291 §5, its example, verbatim (one record, no padding).
  rfc8291_example: {
    plaintext: hex(utf8("When I grow up, I want to be a watermelon")),
    ua_public: hex(Buffer.from("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", "base64url")),
    ua_private: hex(Buffer.from("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94", "base64url")),
    auth: hex(Buffer.from("BTBZMqHH6r4Tts7J_aSIgg", "base64url")),
    as_private: hex(Buffer.from("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", "base64url")),
    as_public: hex(Buffer.from("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8", "base64url")),
    salt: hex(Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url")),
    payload: hex(rfcPayload),
  },
  // K-20: a notification message, its record padded to 2 048 bytes.
  payloads: [{
    message: notificationMessage,
    ua_public: hex(uaPublic),
    ua_private: hex(range(0x51, 32)),
    auth: hex(uaAuth),
    as_private: hex(range(0x91, 32)),
    salt: hex(range(0xb1, 16)),
    payload: hex(goodPayload),
    length: goodPayload.length,
  }],
  // D-41, D-42, §6.5.
  subscriptions: [goodSubscription],
  subscriptions_ignored: [
    ignoredSubscription("a key in uppercase", { key: goodSubscription.key.toUpperCase() }),
    ignoredSubscription("a key of another endpoint", { ...signedSubscription(subscriptionFields, subscriptionKey(`${ENDPOINT}x`)) }),
    ignoredSubscription("an endpoint over http", signedSubscription({ ...subscriptionFields, endpoint: ENDPOINT.replace("https", "http") })),
    ignoredSubscription("an endpoint of 1 025 characters", signedSubscription({ ...subscriptionFields, endpoint: longEndpoint })),
    ignoredSubscription("p256dh of 64 bytes", signedSubscription({ ...subscriptionFields, p256dh_hex: hex(uaPublic.subarray(1)) })),
    ignoredSubscription("p256dh not starting with 04", signedSubscription({ ...subscriptionFields, p256dh_hex: hex(withByte(uaPublic, 0, 5)) })),
    ignoredSubscription("auth of 15 bytes", signedSubscription({ ...subscriptionFields, auth_hex: hex(uaAuth.subarray(1)) })),
    ignoredSubscription("vapid of 31 bytes", signedSubscription({ ...subscriptionFields, vapid_hex: hex(sha256(vapidPublic).subarray(1)) })),
    ignoredSubscription("not signed", { sig: null }),
    ignoredSubscription("another endpoint under the signature", { key: subscriptionKey(`${ENDPOINT}x`), fields: { ...subscriptionFields, endpoint: `${ENDPOINT}x` } }),
    ignoredSubscription("another auth under the signature", { fields: { ...subscriptionFields, auth_hex: hex(range(0x72, 16)) } }),
  ],
  // D-43: what a sender writes, and what a receiver shows.
  message_texts: messageTexts,
  messages_shown: [notificationMessage, notification({ kind: "rejected" }), notification({ title: "" }), JSON.stringify({ ...JSON.parse(notificationMessage), extra: 1 })],
  messages_not_shown: [
    { why: "another version", text: notification({ v: 2 }) },
    { why: "another kind", text: notification({ kind: "accepted" }) },
    { why: "a document in uppercase", text: notification({ doc: ID_DOC.toUpperCase() }) },
    { why: "no title", text: JSON.stringify({ ...JSON.parse(notificationMessage), title: undefined }) },
    { why: "a name that isn't a text", text: notification({ name: 1 }) },
    { why: "an array", text: JSON.stringify([notificationMessage]) },
    { why: "not JSON", text: "D'accord." },
  ],
  // W-59, W-61: bodies the server accepts and refuses (before any post).
  bodies: [pushBody({}), pushBody({ ttl: 0 }), pushBody({ ttl: 604800 }), pushBody({ payload: b64url(rfcPayload) })],
  bodies_refused: [
    { why: "ttl over seven days", status: 400, text: pushBody({ ttl: 604801 }) },
    { why: "ttl negative", status: 400, text: pushBody({ ttl: -1 }) },
    { why: "ttl not an integer", status: 400, text: pushBody({ ttl: 1.5 }) },
    { why: "ttl as text", status: 400, text: pushBody({ ttl: "60" }) },
    { why: "an unknown field", status: 400, text: pushBody({ topic: "d" }) },
    { why: "no payload", status: 400, text: JSON.stringify({ endpoint: ENDPOINT, ttl: 60 }) },
    { why: "an array", status: 400, text: JSON.stringify([ENDPOINT, 60, b64url(goodPayload)]) },
    { why: "a padded payload", status: 400, text: pushBody({ payload: `${b64url(goodPayload)}=` }) },
    { why: "a payload in the standard alphabet", status: 400, text: pushBody({ payload: Buffer.alloc(120, 0xfb).toString("base64") }) },
    { why: "a payload of 4 097 bytes", status: 400, text: pushBody({ payload: b64url(Buffer.concat([withRs(goodPayload, 8192), Buffer.alloc(4097 - goodPayload.length)])) }) },
    { why: "a payload of the header alone", status: 400, text: pushBody({ payload: b64url(goodPayload.subarray(0, 86)) }) },
    { why: "a record of 16 bytes", status: 400, text: pushBody({ payload: b64url(goodPayload.subarray(0, 86 + 16)) }) },
    { why: "a record size of 17", status: 400, text: pushBody({ payload: b64url(withRs(goodPayload.subarray(0, 86 + 17), 17)) }) },
    { why: "a record longer than its record size", status: 400, text: pushBody({ payload: b64url(withRs(goodPayload, 2000)) }) },
    { why: "a key identifier length of 64", status: 400, text: pushBody({ payload: b64url(withByte(goodPayload, 20, 64)) }) },
    { why: "a key identifier not starting with 04", status: 400, text: pushBody({ payload: b64url(withByte(goodPayload, 21, 2)) }) },
    { why: "an endpoint over http", status: 400, text: pushBody({ endpoint: ENDPOINT.replace("https", "http") }) },
    { why: "an endpoint of 1 025 characters", status: 400, text: pushBody({ endpoint: longEndpoint }) },
    { why: "a body over 8 KiB", status: 413, text: pushBody({ endpoint: `${ENDPOINT}${"a".repeat(8192)}` }) },
    { why: "not JSON", status: 400, text: "push" },
  ],
  // W-60: the form of an endpoint, against the default list (before DNS).
  endpoints: [
    ENDPOINT,
    "https://fcm.googleapis.com/fcm/send/abc:APA91b",
    "https://FCM.googleapis.com/wp/abc",
    "https://fcm.googleapis.com:443/wp/abc",
    "https://web.push.apple.com/QGFrZQ",
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
  ],
  endpoints_refused: [
    { why: "http", endpoint: "http://fcm.googleapis.com/wp/abc" },
    { why: "another port", endpoint: "https://fcm.googleapis.com:8443/wp/abc" },
    { why: "user information", endpoint: "https://u:p@fcm.googleapis.com/wp/abc" },
    { why: "a fragment", endpoint: "https://fcm.googleapis.com/wp/abc#x" },
    { why: "a host not listed", endpoint: "https://push.example.org/abc" },
    { why: "a listed name as a prefix", endpoint: "https://fcm.googleapis.com.example.org/abc" },
    { why: "a trailing dot", endpoint: "https://fcm.googleapis.com./wp/abc" },
    { why: "the suffix alone", endpoint: "https://notify.windows.com/w/abc" },
    { why: "an address", endpoint: "https://142.250.74.10/wp/abc" },
    { why: "an IPv6 address", endpoint: "https://[2a00:1450:4007:80a::200a]/wp/abc" },
    { why: "not a URL", endpoint: "fcm.googleapis.com/wp/abc" },
  ],
  // W-60: addresses a resolution may give.
  addresses_public: ["142.250.74.10", "34.107.243.93", "2a00:1450:4007:80a::200a", "17.188.172.92"],
  addresses_refused: [
    { why: "private", address: "10.0.0.1" },
    { why: "private", address: "172.16.0.1" },
    { why: "private", address: "192.168.1.1" },
    { why: "loopback", address: "127.0.0.1" },
    { why: "link-local (cloud metadata)", address: "169.254.169.254" },
    { why: "shared (carrier-grade NAT)", address: "100.64.0.1" },
    { why: "unspecified", address: "0.0.0.0" },
    { why: "multicast", address: "224.0.0.1" },
    { why: "documentation", address: "192.0.2.1" },
    { why: "reserved", address: "240.0.0.1" },
    { why: "broadcast", address: "255.255.255.255" },
    { why: "IPv6 loopback", address: "::1" },
    { why: "IPv6 unspecified", address: "::" },
    { why: "IPv6 link-local", address: "fe80::1" },
    { why: "IPv6 unique local", address: "fc00::1" },
    { why: "IPv6 multicast", address: "ff02::1" },
    { why: "IPv6 documentation", address: "2001:db8::1" },
    { why: "IPv4-mapped loopback", address: "::ffff:127.0.0.1" },
    { why: "IPv4-mapped private", address: "::ffff:10.0.0.1" },
  ],
};

const vectors = {
  comment:
    "Test vectors of docs/protocol/ (version 1). Written by web/scripts/generate-protocol-vectors.mjs, independently of the code they check. Bytes in lowercase hex.",
  keys,
  wire,
  document,
  keyring,
  identity,
  attachment,
  push,
};

writeFileSync(
  new URL("../../docs/protocol/vectors.json", import.meta.url),
  `${JSON.stringify(vectors, null, 2)}\n`,
);
