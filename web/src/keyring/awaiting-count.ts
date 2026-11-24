/** What awaits my reply in one document of « Mes documents », without
 * opening it (ADR-0060 §2): its copy on this
 * device read without the lock, caught up by a connection that writes
 * nothing, then counted as its view counts. Nothing where no copy was
 * kept, nor for one that doesn't read, a link refused, a server that
 * doesn't answer in time (NT5). */
import { LoroDoc } from "loro-crdt";
import {
  AnnotationIndex,
  ConnectionRefused,
  DecisionLog,
  type DocumentConnection,
  LocalDecisions,
  type Role,
  SignatureIndex,
  type SocketFactory,
  type TransportState,
  connectDocument,
  importKeyFromBase64Url,
  parseLinkFragment,
} from "../../lib/src/index.js";
import { type LocalRecord, peekLocalRecord } from "../storage/index.js";
import { AwaitingIndex, type MeSource } from "../view-model/awaiting-index.js";
import { SetAside } from "../view-model/set-aside.js";

export interface CountEnvironment {
  indexedDB: IDBFactory | undefined;
  /** See `storeName`. */
  namespace?: string;
  me: MeSource;
  /** Calls `run` after `ms`; gives its cancel. */
  setTimer(run: () => void, ms: number): () => void;
  socketFactory?: SocketFactory;
  /** For the tests: what the connection has in progress, counted. */
  activity?: Parameters<typeof connectDocument>[0]["activity"];
}

/** Longest wait for the server, then nothing. */
export const COUNT_TIMEOUT_MS = 30_000;

/** Where a connection that writes nothing resumes from a copy (NT1): its
 * cursors, nothing of its own to send again — the tab that holds the lock
 * sends it. */
export function readOnlyResume(record: LocalRecord): TransportState {
  return {
    channels: record.channels.map(({ channel, cursor }) => ({
      channel,
      cursor,
      own: [],
      adopted: [],
    })),
    decisions: { cursor: record.decisions.cursor, outbox: [] },
  };
}

export async function countAwaiting(
  entry: { documentId: string; role: Role; link: string },
  env: CountEnvironment,
  /** Asked to stop: the connection closes, nothing is counted (NT4). */
  stopped: () => boolean = () => false,
): Promise<number | undefined> {
  let address: URL;
  let fragment: ReturnType<typeof parseLinkFragment>;
  try {
    address = new URL(entry.link);
    fragment = parseLinkFragment(address.hash);
  } catch {
    return undefined;
  }
  const key = await importKeyFromBase64Url(fragment.key);
  const record = await peekLocalRecord({
    documentId: entry.documentId,
    role: entry.role,
    key,
    indexedDB: env.indexedDB,
    ...(env.namespace && { namespace: env.namespace }),
  });
  if (!record || stopped()) return undefined;
  const docs = { content: new LoroDoc(), annotations: new LoroDoc() };
  for (const stored of record.channels) {
    docs[stored.channel].import(stored.snapshot);
  }
  const log = new DecisionLog();
  log.add(record.decisions.confirmed);
  let connection: DocumentConnection | undefined;
  let cancel = () => {};
  try {
    const connecting = connectDocument({
      url: `${address.origin.replace(/^http/, "ws")}/ws`,
      documentId: entry.documentId,
      key,
      credentials: { role: entry.role, secret: fragment.secret },
      resume: readOnlyResume(record),
      onConnection: (created) => {
        connection = created;
      },
      channels: [
        { channel: "content", doc: docs.content },
        { channel: "annotations", doc: docs.annotations },
      ],
      decisions: { onConfirmed: (batch) => log.add(batch) },
      ...(env.socketFactory && { socketFactory: env.socketFactory }),
      ...(env.activity && { activity: env.activity }),
    });
    const late = new Promise<"late">((resolve) => {
      cancel = env.setTimer(() => resolve("late"), COUNT_TIMEOUT_MS);
    });
    if ((await Promise.race([connecting, late])) === "late") return undefined;
    cancel();
    if (stopped()) return undefined;
    const index = new AnnotationIndex(docs.content, docs.annotations, log);
    const signatures = new SignatureIndex({
      documentId: entry.documentId,
      annotationsDoc: docs.annotations,
      log,
    });
    signatures.opened();
    const awaiting = new AwaitingIndex({
      annotations: index,
      decisions: new LocalDecisions(log, () => {}),
      signatures,
      me: env.me,
      setAside: new SetAside(record.setAside),
      role: entry.role,
    });
    signatures.current();
    await signatures.idle();
    const count = stopped() ? undefined : awaiting.current().size;
    awaiting.destroy();
    signatures.destroy();
    index.destroy();
    return count;
  } catch (error) {
    if (error instanceof ConnectionRefused) return undefined;
    throw error;
  } finally {
    cancel();
    connection?.close();
  }
}
