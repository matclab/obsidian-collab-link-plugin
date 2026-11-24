// @vitest-environment node
//
// Phase 9, 9c.3 (C10): the fragment of a link comes from whoever sent the
// link. The official parser against the independent client's (written
// from the specification alone), on hostile fragments: the official one
// throws an `Error` or returns, never anything else, and both accept the
// same fragments with the same key, role and secret (K-2, K-18).
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { beforeAll, describe, expect, test } from "vitest";
import { base64UrlToBytes } from "../../lib/src/crypto/role-secrets.js";
import { parseLinkFragment } from "../../lib/src/index.js";
import { linkIndependentLoro } from "./independent-loro.js";

type TC = Parameters<Parameters<typeof hegel.test>[0]>[0];

// biome-ignore lint/suspicious/noExplicitAny: plain JavaScript, without types.
let independent: any;

beforeAll(async () => {
  linkIndependentLoro();
  // @ts-expect-error: plain JavaScript, without types.
  independent = await import("../../../independent-client/protocol.mjs");
});

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/** A base64url value, as K-2 tells them apart. */
function encoded(tc: TC): string {
  const length = tc.draw(gs.sampledFrom([32, 32, 32, 31, 33, 16, 0]));
  const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + 11) & 0xff);
  const good = b64url(bytes);
  switch (tc.draw(gs.integers({ minValue: 0, maxValue: 9 }))) {
    case 0:
      return `${good}=`; // padded
    case 1:
      return good.replace(/[-_]/g, "+") || "+";
    case 2:
      return `${good.slice(0, -1)}${tc.draw(gs.sampledFrom(["A", "B", "z", "9"]))}`; // padding bits
    case 3:
      return `${good}A`; // a length of 4n + 1
    case 4:
      return encodeURIComponent(good).replace(/A/, "%41"); // percent-encoded
    default:
      return good;
  }
}

/** A fragment as a link could carry: `k` and `r`, missing, repeated,
 * reordered, with unknown parameters, separators and encodings. */
function fragment(tc: TC): string {
  const params: string[] = [];
  const role = () =>
    tc.draw(
      gs.sampledFrom(["read", "suggest", "edit", "edit", "Edit", "admin", ""]),
    );
  const r = () => {
    switch (tc.draw(gs.integers({ minValue: 0, maxValue: 7 }))) {
      case 0:
        return `${role()}.${encoded(tc)}.${encoded(tc)}`;
      case 1:
        return `${role()}${encoded(tc)}`;
      case 2:
        return `${role()}%2E${encoded(tc)}`;
      default:
        return `${role()}.${encoded(tc)}`;
    }
  };
  const count = tc.draw(gs.integers({ minValue: 0, maxValue: 4 }));
  for (let i = 0; i < count + 2; i++) {
    const name =
      i < 2
        ? i === 0
          ? "k"
          : "r"
        : tc.draw(gs.sampledFrom(["k", "r", "x", "K", ""]));
    if (i < 2 && tc.draw(gs.integers({ minValue: 0, maxValue: 9 })) === 0)
      continue;
    const value = name === "k" ? encoded(tc) : name === "r" ? r() : "1";
    params.push(
      tc.draw(gs.integers({ minValue: 0, maxValue: 9 })) === 0
        ? name
        : `${name}=${value}`,
    );
  }
  if (tc.draw(gs.booleans())) params.reverse();
  const separator = tc.draw(gs.sampledFrom(["&", "&", "&", "&&", ";"]));
  return `${tc.draw(gs.sampledFrom(["#", "#", "#", "", "##"]))}${params.join(separator)}`;
}

describe("link fragments, official and independent parsers, property", () => {
  test(
    "a hostile fragment: an Error or a result, the same one on both sides",
    () =>
      hegel.test(
        (tc) => {
          const hash = fragment(tc);
          let ours: unknown = null;
          try {
            const { key, role, secret } = parseLinkFragment(hash);
            ours = {
              key: hex(
                base64UrlToBytes(key),
              ) /* as importKeyFromBase64Url reads it */,
              role,
              secret: hex(secret),
            };
          } catch (error) {
            expect(error, hash).toBeInstanceOf(Error);
          }
          const parsed = independent.parseFragment(hash);
          const theirs = parsed && {
            key: hex(parsed.key),
            role: parsed.role,
            secret: hex(parsed.secret),
          };
          expect(ours, hash).toEqual(theirs);
        },
        { testCases: 3000 },
      ),
    60_000,
  );
});
