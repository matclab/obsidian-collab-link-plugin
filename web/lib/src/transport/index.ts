export type {
  ConfirmedRecord,
  ConnectOptions,
  DecisionsConnection,
  ChannelState,
  DocumentConnection,
  TransportState,
} from "./client.js";
export { ConnectionRefused, connectDocument } from "./client.js";
export type { ChannelName } from "./protocol.js";
export {
  CloseCode,
  FRAME_OVERHEAD,
  MAX_EXPIRY_SECONDS,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  mayPublish,
} from "./protocol.js";
export { realWebSocketFactory } from "./socket.js";
export type { SocketFactory, SocketLike } from "./socket.js";
