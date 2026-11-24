// A TCP proxy that delays every chunk by `--delay` ms in each direction,
// in order (a round trip costs twice the delay): network latency without
// `tc netem`, which needs root. Put it between clients and the server.
//
//   node scripts/perf/latency-proxy.mjs [--listen 18081] [--target 127.0.0.1:8080] [--delay 40]
import { createConnection, createServer } from "node:net";
import { args } from "./args.mjs";

const { listen, target, delay } = args({ listen: 18081, target: "127.0.0.1:8080", delay: 40 });
const [host, port] = target.split(":");

/** Writes each chunk `delay` ms after it arrived, never before the one
 * before it. */
function delayed(from, to) {
  let last = 0;
  from.on("data", (chunk) => {
    const at = Math.max(Date.now() + delay, last);
    last = at;
    setTimeout(() => to.writable && to.write(chunk), at - Date.now());
  });
  from.on("close", () => setTimeout(() => to.destroy(), Math.max(0, last - Date.now())));
  from.on("error", () => to.destroy());
}

createServer((client) => {
  const upstream = createConnection({ host, port: Number(port) });
  delayed(client, upstream);
  delayed(upstream, client);
}).listen(listen, "127.0.0.1", () => console.log(`127.0.0.1:${listen} -> ${target}, +${delay} ms each way`));
