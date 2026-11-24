export interface SocketLike {
  send(data: string | Uint8Array): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null;
  /** `code`: the WebSocket close code (ADR-0019 §4), 1006 when the
   * connection dropped without one. */
  onclose: ((event: { code: number }) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export const realWebSocketFactory: SocketFactory = (url) => {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  return socket as unknown as SocketLike;
};
