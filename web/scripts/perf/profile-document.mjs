// A document of the usage profile (docs/phase-9-durcissement.md, *Profil
// d'usage 9e.1*), by Loro's raw API: editing sessions of 30 min, each a
// new page load (a new peer, ADR-0022), typing in bursts with corrections
// and deleted selections, about two annotations per session, the oldest
// resolved so that 50 stay open, a named version every 20 sessions.
// Deterministic: the same arguments give the same bytes.
//
//   node scripts/perf/profile-document.mjs [--weeks 26] [--hours 3] [--chars 2000] [--open 50] [--replies 0] [--out perf-out/profile]
//
// `--replies N`: each annotation gets a thread of N replies (ADR-0035);
// 0, the default, writes no `replies` list (the bytes of before).
//
// Writes content.snapshot, annotations.snapshot and summary.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LoroDoc, LoroList, LoroMap } from "loro-crdt";
import { args } from "./args.mjs";

const { weeks, hours, chars, out, open: OPEN_ANNOTATIONS, replies } = args({
  weeks: 26,
  hours: 3,
  chars: 2000,
  open: 50,
  replies: 0,
  out: "perf-out/profile",
});
const SESSION_HOURS = 0.5;

let seed = 42;
const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const between = (low, high) => low + Math.floor(random() * (high - low + 1));
const WORDS = "le la les un une des et de du en pour sur avec dans par document texte collaboration annotation version page section titre liste".split(" ");
const word = () => WORDS[between(0, WORDS.length - 1)];
const phrase = (low, high) => Array.from({ length: between(low, high) }, word).join(" ");
const id = () => Array.from({ length: 4 }, () => between(0, 0xffffffff).toString(16).padStart(8, "0")).join("-");

const content = new LoroDoc();
const annotations = new LoroDoc();
for (const doc of [content, annotations]) {
  doc.setRecordTimestamp(true);
  doc.setChangeMergeInterval(60); // as the page does (HISTORY_MERGE_SECONDS)
}
const text = content.getText("content");
const entries = annotations.getMap("annotations");
let clock = 1_750_000_000; // seconds
const commit = (doc) => {
  doc.setNextCommitTimestamp(clock);
  doc.commit();
};
const open = [];
let typed = 0;
let deleted = 0;
let created = 0;

const sessions = Math.round((weeks * hours) / SESSION_HOURS);
for (let session = 0; session < sessions; session++) {
  const peer = BigInt(1000 + session);
  content.setPeerId(peer);
  annotations.setPeerId(peer + 1_000_000n);
  clock += between(3600, 3 * 86400);
  for (let budget = SESSION_HOURS * chars; budget > 0; ) {
    clock += between(5, 120);
    // A burst: near the end while the text is short, then anywhere.
    let at = text.length < 2000 || random() < 0.3 ? text.length : between(0, text.length);
    const length = between(20, 300);
    let burst = "";
    while (burst.length < length) burst += (random() < 0.08 ? "\n" : " ") + word();
    for (let i = 0; i < burst.length; i++) {
      text.insert(at++, burst[i]);
      typed++;
      budget--;
      if (random() < 0.05) {
        text.delete(--at, 1); // a backspace
        deleted++;
      }
      if (i % 5 === 4) {
        commit(content);
        clock += 1;
      }
    }
    commit(content);
    // A selection deleted now and then; more often once the text is long.
    if (random() < (text.length > 60_000 ? 0.6 : 0.25)) {
      const length = Math.min(between(5, 400), text.length);
      text.delete(between(0, text.length - length), length);
      deleted += length;
      commit(content);
    }
  }
  for (let k = 0; k < 2 && text.length >= 10; k++) {
    const start = between(0, text.length - 10);
    const type = ["comment", "comment", "deletion", "addition"][between(0, 3)];
    const end = type === "addition" ? start : Math.min(text.length - 1, start + between(1, 60));
    const key = id();
    const entry = entries.setContainer(key, new LoroMap());
    entry.set("type", type);
    entry.set("author", `participant${session % 5}`);
    entry.set("status", "open");
    entry.set("createdAt", clock * 1000);
    entry.set("startCursor", text.getCursor(start)?.encode());
    entry.set("endCursor", text.getCursor(end)?.encode());
    entry.set("endOnLastChar", type !== "addition");
    if (type === "comment") entry.set("body", phrase(5, 30));
    if (type === "addition") {
      const fork = content.fork();
      fork.setPeerId(BigInt(5_000_000 + created));
      const before = fork.oplogVersion();
      fork.getText("content").insert(start, phrase(2, 15));
      fork.commit();
      entry.set("change", fork.export({ mode: "update", from: before }));
    }
    if (replies > 0) {
      const thread = entry.setContainer("replies", new LoroList());
      for (let r = 0; r < replies; r++) {
        const reply = thread.insertContainer(thread.length, new LoroMap());
        reply.set("author", `participant${(session + r + 1) % 5}`);
        reply.set("createdAt", (clock + r * 60) * 1000);
        reply.set("body", phrase(3, 40));
      }
    }
    open.push(key);
    created++;
    commit(annotations);
  }
  while (open.length > OPEN_ANNOTATIONS) {
    entries.get(open.shift()).set("status", "resolved");
    commit(annotations);
  }
  annotations.getMap("peers").set(String(peer), `participant${session % 5}`);
  if (session % 20 === 0) {
    const version = annotations.getMap("versions").setContainer(id(), new LoroMap());
    version.set("name", `version ${session / 20 + 1}`);
    version.set("author", `participant${session % 5}`);
    version.set("at", clock * 1000);
    version.set("frontiers", content.frontiers().map(({ peer, counter }) => ({ peer, counter })));
  }
  commit(annotations);
}

const operations = (doc) => [...doc.oplogVersion().toJSON().values()].reduce((sum, end) => sum + end, 0);
const contentSnapshot = content.export({ mode: "snapshot" });
const annotationsSnapshot = annotations.export({ mode: "snapshot" });
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "content.snapshot"), contentSnapshot);
writeFileSync(join(out, "annotations.snapshot"), annotationsSnapshot);
const summary = {
  weeks,
  hours,
  chars,
  sessions,
  typed,
  deleted,
  textLength: text.length,
  contentOperations: operations(content),
  contentSnapshotBytes: contentSnapshot.length,
  annotations: created,
  openAnnotations: open.length,
  annotationsOperations: operations(annotations),
  annotationsSnapshotBytes: annotationsSnapshot.length,
};
writeFileSync(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary));
