import { describe, expect, test } from "vitest";
import { decodeRecord, encodeRecord } from "./record.js";
import { sample } from "./test-support/sample.js";

describe("local record encoding", () => {
  test("round trip", () => {
    expect(decodeRecord(encodeRecord(sample))).toEqual(sample);
  });

  test("bytes stored as they are, not in base64: the size stays that of the snapshots", () => {
    const big = structuredClone(sample);
    const [content] = big.channels;
    if (content) content.snapshot = new Uint8Array(100_000);
    expect(encodeRecord(big).length).toBeLessThan(100_000 + 1_000);
  });

  test("anything but a well-formed record decodes to undefined", () => {
    const encoded = encodeRecord(sample);
    expect(decodeRecord(new Uint8Array(0))).toBeUndefined();
    expect(decodeRecord(encoded.slice(0, encoded.length - 1))).toBeUndefined();
    const otherVersion = encoded.slice();
    otherVersion[0] = 99;
    expect(decodeRecord(otherVersion)).toBeUndefined();
    const header = new TextEncoder().encode('{"channels":3}');
    const forged = new Uint8Array(5 + header.length);
    forged[0] = 1;
    new DataView(forged.buffer).setUint32(1, header.length);
    forged.set(header, 5);
    expect(decodeRecord(forged)).toBeUndefined();
  });

  test("accepts bytes from another realm (fake-indexeddb under jsdom)", () => {
    const encoded = encodeRecord(sample);
    const foreign = new (class extends Uint8Array {})(encoded);
    expect(decodeRecord(foreign)).toEqual(sample);
  });

  test("what I set aside (ADR-0050 §4): kept; absent in a record of before", () => {
    const aside = {
      ...sample,
      setAside: [
        ["a1", "r2"],
        ["a2", "a2"],
      ] as [string, string][],
    };
    expect(decodeRecord(encodeRecord(aside))).toEqual(aside);
    expect(decodeRecord(encodeRecord(sample))?.setAside).toBeUndefined();
  });

  test("a malformed setting aside is dropped, the rest of the record kept", () => {
    for (const setAside of [
      "a1",
      [["a1"]],
      [["a1", 2]],
      [["a1", "r1", "x"]],
      { a1: "r1" },
    ]) {
      const record = { ...sample, setAside } as unknown as typeof sample;
      const read = decodeRecord(encodeRecord(record));
      expect(read, JSON.stringify(setAside)).toEqual(sample);
    }
  });
});
