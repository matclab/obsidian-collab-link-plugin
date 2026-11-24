/** The QR code of a pairing address: its dark modules as
 * one SVG path, for the page to draw in its colors. `qrcode-generator`
 * (decision 17) places the modules; the page only draws them. */
import qrcode from "qrcode-generator";

/** Light modules around the code, as the standard asks. */
export const QUIET_ZONE = 4;

export interface QrCode {
  /** One `M x y h1v1h-1z` per dark module, in a square of `size`. */
  path: string;
  /** Modules a side, quiet zone included. */
  size: number;
}

/** Byte mode, the smallest version that holds `text`, error correction
 * `M` (15 %): a screen photographed at an angle, a glare. */
export function qrCode(text: string): QrCode {
  const code = qrcode(0, "M");
  code.addData(text, "Byte");
  code.make();
  const count = code.getModuleCount();
  const squares: string[] = [];
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (code.isDark(row, col)) {
        squares.push(`M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`);
      }
    }
  }
  return { path: squares.join(""), size: count + 2 * QUIET_ZONE };
}
