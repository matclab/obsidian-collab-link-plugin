import { describe, expect, test } from "vitest";
import { CloseCode } from "./protocol.js";
import { ReconnectPolicy } from "./reconnect.js";

describe("ReconnectPolicy", () => {
  test("a final code never reconnects: every 44xx but too slow and too many connections, known or not", () => {
    const policy = new ReconnectPolicy(500);
    for (const code of [4400, 4401, 4403, 4404, 4410, 4426, 4499, 4450]) {
      expect(policy.delay(code)).toBeUndefined();
    }
  });

  test("a network loss or a slow connection reconnects after the fixed delay", () => {
    const policy = new ReconnectPolicy(500);
    for (const code of [1006, 1000, CloseCode.TooSlow, 4500, 4399]) {
      expect(policy.delay(code)).toBe(500);
    }
  });

  test("a crowded document doubles the wait from 1 s up to 30 s, ±20 %, until authenticated", () => {
    const at = (random: number) => {
      const policy = new ReconnectPolicy(500, () => random);
      return Array.from({ length: 7 }, () =>
        Math.round(policy.delay(CloseCode.TooManyConnections) ?? Number.NaN),
      );
    };
    expect(at(0.5)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(at(0)).toEqual([800, 1600, 3200, 6400, 12800, 24000, 24000]);
    expect(at(1)).toEqual([1200, 2400, 4800, 9600, 19200, 36000, 36000]);

    const policy = new ReconnectPolicy(500, () => 0.5);
    policy.delay(CloseCode.TooManyConnections);
    policy.delay(CloseCode.TooManyConnections);
    policy.authenticated();
    expect(policy.delay(CloseCode.TooManyConnections)).toBe(1000);
  });

  test("another code doesn't reset the crowded wait", () => {
    const policy = new ReconnectPolicy(500, () => 0.5);
    policy.delay(CloseCode.TooManyConnections);
    policy.delay(1006);
    expect(policy.delay(CloseCode.TooManyConnections)).toBe(2000);
  });
});
