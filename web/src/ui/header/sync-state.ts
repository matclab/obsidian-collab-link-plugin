/** What the header says of this browser's changes,
 * from what the page already knows: how many changes only this browser
 * holds, and whether the browser believes it is online. */
export type SyncState = "saved" | "sending" | "offline";

export function syncState(unsent: number, online: boolean): SyncState {
  if (unsent === 0) return "saved";
  return online ? "sending" : "offline";
}
