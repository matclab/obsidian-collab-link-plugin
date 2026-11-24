import { LoroDoc } from "loro-crdt";

/** A cursor `Cursor.decode` accepts, on `content`, at counter -1: resolving
 * it with `getCursorPos` traps and leaves the document unusable, whatever
 * document resolves it (docs/phase-9-durcissement.md, analysis 9c.1). A
 * legitimate cursor whose counter byte (a zigzag varint, third byte for
 * peer 1) is changed from `04` (2) to `01` (-1). */
export function hostileCursorBytes(): Uint8Array {
  const doc = new LoroDoc();
  doc.setPeerId(1n);
  doc.getText("content").insert(0, "hello");
  doc.commit();
  const bytes = doc.getText("content").getCursor(2)?.encode();
  if (!bytes) throw new Error("no cursor");
  const hostile = Uint8Array.from(bytes);
  hostile[2] = 0x01;
  return hostile;
}
