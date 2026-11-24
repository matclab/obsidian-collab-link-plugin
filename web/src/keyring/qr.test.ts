// The QR code of a pairing address (analysis 18f): what the page draws —
// its modules, then the SVG path of them — decodes, read by an independent
// decoder (`jsqr`) as a camera would, to the address itself; for addresses
// of every length a server's origin gives.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import jsQR from "jsqr";
import { describe, expect, test } from "vitest";
import { formatPairingAddress } from "../../lib/src/index.js";
import { QUIET_ZONE, qrCode } from "./qr.js";

/** Paints the SVG path's unit squares (`M x y h1v1h-1z`), as a camera
 * would see them: dark on light, `scale` pixels a module. */
function paint(path: string, size: number, scale = 4): Uint8ClampedArray {
  const side = size * scale;
  const pixels = new Uint8ClampedArray(side * side * 4).fill(255);
  for (const [, x, y] of path.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
    for (let dy = 0; dy < scale; dy++) {
      for (let dx = 0; dx < scale; dx++) {
        const at =
          ((Number(y) * scale + dy) * side + Number(x) * scale + dx) * 4;
        pixels.fill(0, at, at + 3);
      }
    }
  }
  return pixels;
}

describe("the QR code of a pairing address", () => {
  test("it decodes to the address, whatever the server's origin", () =>
    hegel.test(
      (tc) => {
        const host = tc.draw(
          gs.fromRegex("[a-z][a-z0-9-]{0,40}(\\.[a-z]{2,10}){1,2}", {
            fullmatch: true,
          }),
        );
        const port = tc.draw(gs.booleans())
          ? `:${tc.draw(gs.integers({ minValue: 1025, maxValue: 65535 }))}`
          : "";
        const id = Buffer.from(
          tc.draw(gs.binary({ minSize: 16, maxSize: 16 })),
        ).toString("hex");
        const key = tc.draw(gs.binary({ minSize: 32, maxSize: 32 }));
        const address = formatPairingAddress(`https://${host}${port}`, id, key);
        const { path, size } = qrCode(address);
        const side = size * 4;
        const read = jsQR(paint(path, size), side, side);
        expect(read?.data).toBe(address);
      },
      { testCases: 50 },
    ));

  test("a quiet zone of four modules surrounds it", () => {
    const { path, size } = qrCode("https://collab.example.org/?pair=x#p=y");
    const xs = [...path.matchAll(/M(\d+) (\d+)/g)].flatMap(([, x, y]) => [
      Number(x),
      Number(y),
    ]);
    expect(QUIET_ZONE).toBe(4);
    expect(Math.min(...xs)).toBe(QUIET_ZONE);
    expect(Math.max(...xs)).toBe(size - QUIET_ZONE - 1);
  });
});
