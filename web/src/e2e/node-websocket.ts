import { WebSocket as NodeWebSocket } from "ws";
import type {
  SocketFactory,
  SocketLike,
} from "../../lib/src/transport/socket.js";

// Node's native global `WebSocket` (undici) fires events built from its own
// `Event` class, which clashes with jsdom's replacement `Event`/`EventTarget`
// globals ("event argument must be an instance of Event. Received an
// instance of Event") when a test needs both a real DOM (for CodeMirror) and
// a real WebSocket in the same process. The `ws` package sidesteps this
// entirely by not using DOM event classes at all.
function wrap(ws: NodeWebSocket): SocketLike {
  const socket: SocketLike = {
    onopen: null,
    onmessage: null,
    onclose: null,
    send(data) {
      ws.send(data);
    },
    close() {
      ws.close();
    },
  };
  ws.on("open", () => socket.onopen?.());
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      const arrayBuffer = data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength,
      ) as ArrayBuffer;
      socket.onmessage?.({ data: arrayBuffer });
    } else {
      socket.onmessage?.({ data: data.toString("utf8") });
    }
  });
  ws.on("close", (code: number) => socket.onclose?.({ code }));
  return socket;
}

export const nodeWebSocketFactory: SocketFactory = (url) =>
  wrap(new NodeWebSocket(url));

/** A `SocketFactory` that also exposes a way to kill the most recently
 * created socket without a close handshake — a real, abrupt network drop
 * (unlike `DocumentConnection.close()`, which sends a real close frame but
 * is still a graceful, client-initiated disconnect). Used to check that
 * `connectDocument`'s own internal reconnect timer — not a fresh
 * `connectDocument` call standing in for one — resumes correctly against
 * the real server (docs/phase-2-persistance-reprise.md step 9). */
export function createTrackedNodeWebSocketFactory(): {
  factory: SocketFactory;
  killLast: () => void;
} {
  let last: NodeWebSocket | undefined;
  const factory: SocketFactory = (url) => {
    const ws = new NodeWebSocket(url);
    last = ws;
    return wrap(ws);
  };
  return { factory, killLast: () => last?.terminate() };
}
