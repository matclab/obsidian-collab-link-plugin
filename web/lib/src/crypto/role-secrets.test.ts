import { createHash, hkdfSync } from "node:crypto";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import {
  ROLES,
  type Role,
  deriveRoleSecrets,
  generateEditSecret,
  verifier,
  verifiers,
} from "./role-secrets.js";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const E = new Uint8Array(32).fill(0x42);

describe("role secrets (ADR-0019 §2)", () => {
  // Computed with two independent Python implementations
  // (docs/phase-5-modele-acces.md, step 4).
  test("derives the reference read and suggest secrets", async () => {
    const secrets = await deriveRoleSecrets(E);

    expect(hex(secrets.read)).toBe(
      "55c3f631ab5af0bde98f0c7b8bbc61ca07a09e564c07a50d043416a83cb3c956",
    );
    expect(hex(secrets.suggest)).toBe(
      "5a2675f5c1baa2bba5fc396449dfa8fb1c3b1687d8fee8c31352f72f1d953ee8",
    );
    expect(secrets.edit).toEqual(E);
  });

  // The server's own vector (server/auth/src/lib.rs).
  test("computes the server's reference verifier", async () => {
    expect(hex(await verifier("suggest", E))).toBe(
      "dfdf95ead20c9accf825098e7b714a382cbb6d4e47cfa35d45698ac64f82d867",
    );
  });

  test("draws a fresh 256-bit edit secret each time", () => {
    const a = generateEditSecret();
    const b = generateEditSecret();

    expect(a).toHaveLength(32);
    expect(hex(a)).not.toBe(hex(b));
  });

  test("derivations and verifiers equal node:crypto on any edit secret", () =>
    hegel.testAsync(async (tc) => {
      const edit = new Uint8Array(
        tc.draw(gs.binary({ minSize: 32, maxSize: 32 })),
      );
      const secrets = await deriveRoleSecrets(edit);
      const all = await verifiers(edit);
      for (const role of ROLES) {
        const expected =
          role === "edit"
            ? Buffer.from(edit)
            : Buffer.from(
                hkdfSync(
                  "sha256",
                  edit,
                  new Uint8Array(0),
                  `obsidian-collab/${role}/v1`,
                  32,
                ),
              );
        if (hex(secrets[role]) !== expected.toString("hex")) {
          throw new Error(`${role} secret differs from node:crypto`);
        }
        const reference = createHash("sha256")
          .update("obsidian-collab/verifier/v1")
          .update(new Uint8Array([0]))
          .update(role)
          .update(new Uint8Array([0]))
          .update(expected)
          .digest("hex");
        if (hex(all[role]) !== reference) {
          throw new Error(`${role} verifier differs from node:crypto`);
        }
      }
    }));

  test("no secret verifies for another role, nor another secret", () =>
    hegel.testAsync(async (tc) => {
      const secret = new Uint8Array(
        tc.draw(gs.binary({ minSize: 32, maxSize: 32 })),
      );
      const other = new Uint8Array(
        tc.draw(gs.binary({ minSize: 32, maxSize: 32 })),
      );
      const role = tc.draw(gs.sampledFrom([...ROLES])) as Role;
      const otherRole = tc.draw(gs.sampledFrom([...ROLES])) as Role;
      const same = hex(secret) === hex(other) && role === otherRole;
      const equal =
        hex(await verifier(role, secret)) ===
        hex(await verifier(otherRole, other));
      if (equal !== same) throw new Error("verifiers collide");
    }));
});
