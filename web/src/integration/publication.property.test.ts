// Publication and resumption under every delivery order the real server
// allows (ADR-0015, docs/phase-4ter-*.md step 5): several clients on two
// Loro channels, a server whose two queues per connection — replies and
// acks, pushes — are delivered in an order Hegel draws (the
// `tokio::select!` of ADR-0011), connections dropped at any point,
// compactions. Once everything is delivered:
//
// - every client holds every operation any client wrote (nothing was
//   skipped by a resumption, nothing waits forever on a missing
//   dependency);
// - the journal alone holds them too: a client opening now gets them all;
// - each entry carries the operations of one client only (nobody
//   publishes what it received);
// - I4 (ADR-0017, R-A1): imported entry by entry in journal order,
//   nothing ever waits — no entry depends on a later one.
//
// With access (ADR-0019, docs/phase-5-modele-acces.md step 4): each
// client's role is drawn, and what it may not publish stays local; editors
// adopt detached changes and type after them, renew the links at any
// point, and revoked clients open the new link as a new page. Then also:
// the server never closes a connection but for a replaced link (no 4403,
// no 4400); every client ends connected; a requester is never cut by its
// own rotation; every live adoption reaches every client. In half the
// cases the server reads at most 300 bytes per message (O-18): own
// operations leave in several frames, and no message is ever cut.
import * as hegel from "@hegeldev/hegel";
import { describe, test } from "vitest";
import { runScenario } from "./scenario/run.js";
import { hegelChoose } from "./scenario/world.js";

describe("publication and resumption (ADR-0015)", () => {
  test(
    "every write reaches every client and the journal, once, under any delivery order",
    () =>
      hegel.testAsync(
        async (tc) => {
          const problems = await runScenario(hegelChoose(tc), {
            compaction: true,
            maxSteps: 30,
            rotation: true,
            adoption: true,
            roles: true,
            smallMessages: true,
          });
          if (problems.length > 0) throw new Error(problems.join("\n"));
        },
        { testCases: 60 },
      ),
    600_000,
  );
});
