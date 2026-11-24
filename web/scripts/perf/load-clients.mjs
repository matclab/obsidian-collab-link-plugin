// Clients of the reference library (lib/, `openLink`) on one document:
// how long each takes to open, and how long a keystroke of a writer takes
// to reach the others (end to end: encryption, relay, decryption, import).
// A writer types one character per tick and, in the same commit, writes
// its send time in a `probe` map, which the readers time on arrival. All
// clients share this process (and its clock); run fewer to time latency
// alone. Run `npm run build:lib` first.
//
//   node scripts/perf/load-clients.mjs --link '<edit link>' [--server URL] [--clients 32] [--writers 2] [--rate 5] [--seconds 30]
import { openLink } from "../../lib/dist/index.js";
import { args } from "./args.mjs";

const { link, server, clients, writers, rate, seconds } = args({
  link: "",
  server: "",
  clients: 32,
  writers: 2,
  rate: 5,
  seconds: 30,
});
if (!link) {
  console.error("--link is required (an edit link: writers need it)");
  process.exit(2);
}
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null;
};
const round = (value) => (value === null ? null : Math.round(value * 10) / 10);

const opened = [];
const openMs = [];
for (let i = 0; i < clients; i++) {
  const start = performance.now();
  const client = await openLink(link, server ? { server } : {});
  openMs.push(performance.now() - start);
  opened.push(client);
}

const latencies = [];
const run = Date.now().toString(36);
// Probes of earlier runs on this document are not this run's.
const seen = opened.map((client) => new Set(client.content.getMap("probe").keys()));
opened.forEach((client, index) => {
  const probe = client.content.getMap("probe");
  client.content.subscribe(() => {
    const now = Date.now();
    for (const [key, sentAt] of probe.entries()) {
      if (seen[index].has(key)) continue;
      seen[index].add(key);
      if (!key.startsWith(`${run}:w${index}:`)) latencies.push(now - sentAt);
    }
  });
});

let sent = 0;
const timers = opened.slice(0, writers).map((client, index) => {
  const text = client.content.getText("content");
  const probe = client.content.getMap("probe");
  let n = 0;
  return setInterval(() => {
    text.insert(Math.floor(text.length / 2), "x");
    probe.set(`${run}:w${index}:${n++}`, Date.now());
    client.content.commit();
    sent++;
  }, 1000 / rate);
});
await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
for (const timer of timers) clearInterval(timer);
await new Promise((resolve) => setTimeout(resolve, 2000)); // the last ones arrive
for (const client of opened) client.close();

const expected = sent * (clients - 1);
console.log(
  JSON.stringify({
    clients,
    writers,
    rate,
    seconds,
    openMs: { first: round(openMs[0]), p50: round(percentile(openMs, 50)), max: round(Math.max(...openMs)) },
    keystrokes: sent,
    received: latencies.length,
    expected,
    latencyMs: {
      p50: round(percentile(latencies, 50)),
      p95: round(percentile(latencies, 95)),
      p99: round(percentile(latencies, 99)),
      max: round(latencies.length ? Math.max(...latencies) : null),
    },
  }),
);
process.exit(0);
