// The revocation list in the page (docs/protocol/06-identity.md, ID-40;
// analysis 18k, case 6): read from the server's origin when the view
// opens, then every 10 minutes; a valid list retained, never an older one
// nor an invalid one (AT4); nothing served, or no network, nothing
// revoked — and those who listen told only of a newer list.
import { describe, expect, test } from "vitest";
import { vectors } from "../../lib/src/test-support/vectors.js";
import { REREAD_MS, RevocationReader } from "./revocations.js";

const v = vectors.identity.attestations;
const [older, newer] = v.revocation_bodies as {
  text: string;
  issued_at: number;
}[];

function setUp(answers: (() => Response)[]) {
  const asked: string[] = [];
  const timers: { ms: number; run: () => void }[] = [];
  const reader = new RevocationReader({
    apiBase: "https://collab.test",
    configured: new Set(v.configured),
    fetch: async (url) => {
      asked.push(url);
      const answer = answers.shift();
      if (!answer) throw new TypeError("offline");
      return answer();
    },
    setTimer: (run, ms) => {
      const timer = { ms, run };
      timers.push(timer);
      return () => timers.splice(timers.indexOf(timer), 1);
    },
  });
  return { reader, asked, timers };
}

const body = (text: string) => () => new Response(text, { status: 200 });

describe("the revocation list in the page", () => {
  test("read at once, then every 10 minutes; the newest kept", async () => {
    const s = setUp([
      body(older?.text ?? ""),
      body(newer?.text ?? ""),
      body(older?.text ?? ""),
    ]);
    let told = 0;
    s.reader.subscribe(() => {
      told += 1;
    });
    await s.reader.read();
    expect(s.asked).toEqual(["https://collab.test/revocations"]);
    expect(s.reader.current()?.issuedAt).toBe(older?.issued_at);
    expect(s.timers.map((timer) => timer.ms)).toEqual([REREAD_MS]);
    // The timer's own reading, awaited: not another one beside it.
    s.timers[0]?.run();
    await s.reader.settled();
    expect(s.reader.current()?.issuedAt).toBe(newer?.issued_at);
    // AT4: an older one, served again, changes nothing.
    await s.reader.read();
    expect(s.reader.current()?.issuedAt).toBe(newer?.issued_at);
    expect(told).toBe(2);
  });

  test("an invalid list, nothing served, no network: nothing revoked, none told", async () => {
    const refused = (v.revocation_bodies_refused as { text: string }[])[0];
    const s = setUp([
      body(refused?.text ?? ""),
      () => new Response(null, { status: 404 }),
    ]);
    let told = 0;
    s.reader.subscribe(() => {
      told += 1;
    });
    await s.reader.read();
    await s.reader.read();
    await s.reader.read();
    expect(s.reader.current()).toBeUndefined();
    expect(told).toBe(0);
  });

  test("closed, it reads no more", async () => {
    const s = setUp([body(older?.text ?? "")]);
    await s.reader.read();
    s.reader.close();
    expect(s.timers).toEqual([]);
  });
});
