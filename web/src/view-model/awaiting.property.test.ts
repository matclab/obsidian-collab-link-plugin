import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import type {
  Annotation,
  Attestation,
  SignatureView,
  Verdict,
} from "../../lib/src/index.js";
import { replyKey } from "../../lib/src/index.js";
import { type Me, awaits, entryOwner, threadOf } from "./awaiting.js";

// ADR-0050 §1 and §2, phase 23 (AF2, AF3, AF4).

const KEYS = [1, 2, 3].map((n) => new Uint8Array(32).fill(n));
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const NAMES = ["Alice", "Bob", "alice"];
const ACCOUNTS = [
  { issuer: "https://idp.example", sub: "alice" },
  { issuer: "https://idp.example", sub: "bob" },
  { issuer: "https://other.example", sub: "alice" },
];
const SIG = new Uint8Array(72);

type TC = Parameters<Parameters<typeof hegel.test>[0]>[0];

function drawMe(tc: TC): Me {
  const keys = new Set(
    KEYS.filter(() => tc.draw(gs.booleans())).map((key) => hex(key)),
  );
  const account = tc.draw(gs.booleans())
    ? tc.draw(gs.sampledFrom(ACCOUNTS))
    : undefined;
  return {
    keys,
    ...(account && { account }),
    pseudonym: tc.draw(gs.sampledFrom(NAMES)),
  };
}

/** An entry as written, and its verdict once verified. */
function drawEntry(tc: TC): {
  author: string;
  sig?: Uint8Array;
  verdict: Verdict;
} {
  const author = tc.draw(gs.sampledFrom(NAMES));
  const kind = tc.draw(gs.sampledFrom(["unsigned", "failed", "signed"]));
  if (kind === "unsigned") return { author, verdict: { signed: false } };
  if (kind === "failed")
    return { author, sig: SIG, verdict: { signed: false } };
  const key = tc.draw(gs.sampledFrom(KEYS));
  const account = tc.draw(gs.booleans())
    ? tc.draw(gs.sampledFrom(ACCOUNTS))
    : undefined;
  const attested: Attestation | undefined = account && {
    id: "a",
    ...account,
    name: "N",
    key,
    issuedAt: 0,
    expiresAt: 1,
  };
  return {
    author,
    sig: SIG,
    verdict: {
      signed: true,
      fingerprint: key,
      short: "",
      twoKeys: false,
      ...(attested && { attested }),
    },
  };
}

/** ADR-0050 §1, as written: none of mine, or another's after my last. */
function modelAwaits(
  owners: readonly ("me" | "other")[],
  lastId: string,
  setAside: string | undefined,
): boolean {
  if (owners.length === 0 || setAside === lastId) return false;
  const last = owners.lastIndexOf("me");
  if (last < 0) return true;
  return owners.slice(last + 1).includes("other");
}

describe("what awaits me (property)", () => {
  test(
    "AF2, AF3: the thread's owners and whether it awaits me, against the ADR's words",
    () =>
      hegel.test(
        (tc) => {
          const me = drawMe(tc);
          const first = drawEntry(tc);
          const n = tc.draw(gs.integers({ minValue: 0, maxValue: 5 }));
          const replies = Array.from({ length: n }, (_, i) => ({
            ...drawEntry(tc),
            // An older client's reply has no id.
            ...(tc.draw(gs.booleans()) && { id: `r${i}` }),
          }));
          const annotation = {
            id: "a",
            author: first.author,
            ...(first.sig && { sig: first.sig }),
            replies: replies.map(({ verdict: _, ...reply }) => ({
              ...reply,
              createdAt: 0,
              body: "x",
            })),
          } as unknown as Annotation;
          const verdicts = new Map<string, Verdict>([
            ["annotation|a", first.verdict],
          ]);
          for (const reply of replies) {
            if (reply.id !== undefined) {
              verdicts.set(`reply|${replyKey("a", reply.id)}`, reply.verdict);
            }
          }
          const view: SignatureView = {
            of: (kind, id) =>
              verdicts.get(`${kind}|${id}`) ?? { signed: false },
            version: () => "",
            settled: true,
          };
          const thread = threadOf(annotation, view, me);

          // AF3: who an entry is, from what it is.
          const entries = [first, ...replies];
          entries.forEach((entry, at) => {
            // A reply without an id can't be verified: as unsigned.
            const verdict =
              at > 0 && (entry as { id?: string }).id === undefined
                ? ({ signed: false } as Verdict)
                : entry.verdict;
            const expected = verdict.signed
              ? me.keys.has(hex(verdict.fingerprint)) ||
                (verdict.attested !== undefined &&
                  me.account?.issuer === verdict.attested.issuer &&
                  me.account?.sub === verdict.attested.sub)
              : entry.sig === undefined && entry.author === me.pseudonym;
            const owner = thread[at]?.owner;
            if (owner !== (expected ? "me" : "other")) {
              throw new Error(`entry ${at}: ${owner}`);
            }
            // Never by the name a signed entry carries.
            if (verdict.signed || entry.sig) {
              const renamed = entryOwner(
                { ...entry, author: me.pseudonym },
                verdict,
                me,
              );
              const other = entryOwner(
                { ...entry, author: "Zoé" },
                verdict,
                me,
              );
              if (renamed !== other) throw new Error(`by its name: ${at}`);
            }
          });

          // AF2.
          const ids = thread.map((entry) => entry.id);
          const setAside = tc.draw(gs.booleans())
            ? tc.draw(gs.sampledFrom(ids))
            : undefined;
          const owners = thread.map((entry) => entry.owner);
          const lastId = ids.at(-1) ?? "";
          if (
            awaits(thread, setAside) !== modelAwaits(owners, lastId, setAside)
          ) {
            throw new Error(
              `awaits: ${owners.join(",")} set aside ${setAside}`,
            );
          }

          // AF4: another's new entry brings it back, set aside or not;
          // mine takes it away.
          if (!awaits([...thread, { id: "new", owner: "other" }], setAside)) {
            throw new Error("another's new entry didn't bring it back");
          }
          if (awaits([...thread, { id: "new", owner: "me" }], setAside)) {
            throw new Error("my new entry didn't take it away");
          }
        },
        { testCases: 400 },
      ),
    60_000,
  );
});
