// The vault's keyring as the server of the settings changes, its order
// drawn by Hegel (AGENTS.md §1.6): the server changed, the keyring asked
// for, « Mes documents » changed (its session opened again), in any order;
// the device's seal key read and each session opened when the test says.
// Checked at each request: VK1 (one environment per server); at rest, VK2
// (each session replaced closed once, the last one at unload) and VK3 (the
// current session is the last server's).
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { KeyringHost } from "./vault-keyring.js";

/** A wait, ended when the test says. */
const pending: (() => void)[] = [];
const gate = <T>(value: () => T) =>
  new Promise<T>((resolve) => {
    pending.push(() => resolve(value()));
  });

interface FakeSession {
  server: string;
  closes: number;
  close(): void;
}
const sessions: FakeSession[] = [];
let sealKeys = 0;

vi.mock("./seal-key.js", () => ({
  deviceSealKey: () => {
    sealKeys += 1;
    return gate(() => ({}));
  },
}));
vi.mock("../../web/src/embed.js", async (original) => ({
  ...(await original<typeof import("../../web/src/embed.js")>()),
  openKeyringLocal: () => ({}),
  sessionOptions: (_env: unknown, server: string) => ({ server }),
  KeyringSession: {
    open: ({ server }: { server: string }) =>
      gate(() => {
        const session: FakeSession = {
          server,
          closes: 0,
          close() {
            session.closes += 1;
          },
        };
        sessions.push(session);
        return session;
      }),
  },
}));

const { VaultKeyring } = await import("./vault-keyring.js");

/** Every microtask through. */
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

const SERVERS = ["https://a.test", "https://b.test"] as const;

beforeEach(() => {
  pending.length = 0;
  sessions.length = 0;
  sealKeys = 0;
});

describe("VaultKeyring", () => {
  test("VK1–VK3, whatever the order of the server's changes, the requests and the sessions' openings", async () => {
    await hegel.testAsync(
      async (tc) => {
        pending.length = 0;
        sessions.length = 0;
        sealKeys = 0;
        let server: string = SERVERS[0];
        const keyring = new VaultKeyring({
          settings: { serverSet: () => server },
          secrets: {},
          localStore: () => ({ indexedDB: {}, keyringLock: {} }),
          vaultId: () => "vault",
          request: async () => ({}),
          setTimer: () => () => {},
          openExternal: () => {},
        } as unknown as KeyringHost);
        /** The server the keyring was last built on, and its environment. */
        let built: { server: string; env: Promise<unknown> } | undefined;
        const problems: string[] = [];
        const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 14 }));
        for (let i = 0; i < steps; i++) {
          const move = tc.draw(
            gs.sampledFrom(["server", "ensure", "changed", "end"] as const),
          );
          if (move === "server") {
            server = tc.draw(gs.sampledFrom(SERVERS));
          } else if (move === "ensure") {
            const before = sealKeys;
            const env = keyring.ensure();
            // VK1: built once per server.
            if (built?.server === server) {
              if (env !== built.env) problems.push("VK1: built again");
              if (sealKeys !== before) problems.push("VK1: key read again");
            } else {
              built = { server, env };
            }
          } else if (move === "changed") {
            void keyring.reopenSession();
          } else if (pending.length > 0) {
            const at = tc.draw(
              gs.integers({ minValue: 0, maxValue: pending.length - 1 }),
            );
            pending.splice(at, 1)[0]?.();
          }
          await turn();
          expect(problems).toEqual([]);
        }
        // At rest: every wait ended.
        while (pending.length > 0) {
          pending.shift()?.();
          await turn();
        }
        const current = (await keyring.current()) as FakeSession | undefined;
        // VK3: the current session is the last server's.
        expect(current?.server).toBe(built?.server);
        // VK2: each session replaced closed once, the current one open.
        for (const session of sessions) {
          expect(session.closes).toBe(session === current ? 0 : 1);
        }
        keyring.close();
        await turn();
        // VK2: the last one closed at unload.
        if (current) expect(current.closes).toBe(1);
      },
      { testCases: 400 },
    );
  }, 300_000);
});
