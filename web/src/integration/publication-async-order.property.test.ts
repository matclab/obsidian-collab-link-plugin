// The scenario of `publication.property.test.ts`, with more left to
// Hegel: when each encryption and decryption completes
// (test-support/crypto-gate.ts), when each timer fires (publication
// interval, reconnection delay), and the decisions channel. A connection
// can drop, a message arrive, while a frame is being encrypted; two
// messages delivered in order can be decrypted in the other; a reconnect
// can wait while everything else moves. Pages reload from their local
// record (ADR-0022): each store write completes when Hegel says, and a
// reload drops or keeps the one in progress. Same properties, and for
// decisions those of DecisionsConnection: every batch extends a gapless
// prefix of the journal; in the end every client confirmed every record,
// and every record decided was journaled; for the local record, phase 7 L1 (all
// it held reaches the journal) and L2 (it holds what its cursor covers).
// Editors set the expiry and may delete the document (ADR-0023): every
// expiry request settles with the server's value or fails with its
// connection; only a deleted document is reported deleted, and then every
// client ends refused for good; no client is cut by its own rotation that
// passed, even after sending another. Pages send presence states
// (ADR-0025): each one received is intact and another page's, none is
// journaled nor sent by a reader, and the acks of the other frames still
// pair (the properties above). The server also sends what a later
// extension of the protocol would (docs/phase-8-protocole-ouvert.md, N4):
// ignored, it pairs with nothing either.
import * as hegel from "@hegeldev/hegel";
import { describe, test, vi } from "vitest";
import { cryptoGate } from "../../lib/src/transport/test-support/crypto-gate.js";
import { runScenario } from "./scenario/run.js";
import { hegelChoose } from "./scenario/world.js";

vi.mock("../../lib/src/crypto/aead.js", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../../lib/src/crypto/aead.js")>();
  return {
    ...real,
    encrypt: cryptoGate.wrap("encrypt", real.encrypt),
    decrypt: cryptoGate.wrap("decrypt", real.decrypt),
  };
});

describe("publication and resumption under any order of async work", () => {
  test(
    "every write and decision reaches every client and the journal",
    () =>
      hegel.testAsync(
        async (tc) => {
          try {
            const problems = await runScenario(hegelChoose(tc), {
              compaction: true,
              maxSteps: 40,
              gate: cryptoGate,
              clock: true,
              decisions: true,
              rotation: true,
              adoption: true,
              roles: true,
              reload: true,
              lifecycle: true,
              presence: true,
              unknown: true,
            });
            if (problems.length > 0) throw new Error(problems.join("\n"));
          } finally {
            cryptoGate.stop();
          }
        },
        { testCases: 400 },
      ),
    600_000,
  );
});
