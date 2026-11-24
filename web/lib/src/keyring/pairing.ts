/** Adding a device (docs/protocol/05-keyring.md, §5.10): the keyring
 * link sealed under a pairing key `P` for a deposit the server keeps a few
 * minutes (KR-34), the address that carries the deposit's id and `P` to
 * the other device (KR-35), and the strict reading of a deposit taken
 * (KR-36). `P` travels in a fragment: never to a server. */
import { base64UrlToBytes, bytesToBase64Url } from "../crypto/role-secrets.js";
import {
  type KeyringCredentials,
  decryptKeyring,
  encryptKeyring,
  parseKeyringLink,
} from "./crypto.js";

const KEY_BYTES = 32;
const ID = /^[0-9a-f]{32}$/;

/** What a pairing address carries (KR-35). */
export interface PairingAddress {
  pairingId: string;
  /** `P`, the key of the deposit. */
  key: Uint8Array;
  /** A deposit of an account, kept by the gateway (KR-43). */
  account: boolean;
}

/** A fresh pairing key, one per deposit (KR-34). */
export function newPairingKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

/** The deposit of `keyringLink` under `key` (KR-34). */
export function sealPairing(
  key: Uint8Array,
  keyringLink: string,
): Promise<Uint8Array> {
  const plaintext = JSON.stringify({ v: 1, keyring: keyringLink });
  return encryptKeyring(key, new TextEncoder().encode(plaintext));
}

/** A deposit that isn't one, whatever the reason (KR-36): the page says
 * the code is unreadable. */
export class UnreadableDeposit extends Error {
  constructor(cause: unknown) {
    super("unreadable deposit", { cause });
    this.name = "UnreadableDeposit";
  }
}

/** The keyring a deposit hands over; rejects anything else with
 * `UnreadableDeposit` (KR-36). */
export async function openPairing(
  key: Uint8Array,
  deposit: Uint8Array,
): Promise<KeyringCredentials> {
  try {
    return await readDeposit(key, deposit);
  } catch (error) {
    throw new UnreadableDeposit(error);
  }
}

async function readDeposit(
  key: Uint8Array,
  deposit: Uint8Array,
): Promise<KeyringCredentials> {
  const plaintext = await decryptKeyring(key, deposit);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("a deposit is a JSON object");
  }
  const { v, keyring } = value as Record<string, unknown>;
  if (v !== 1) throw new Error("unsupported deposit version");
  if (typeof keyring !== "string") throw new Error("a deposit has a keyring");
  return parseKeyringLink(keyring);
}

/** `<origin>/?pair=<id>#p=<P>` (KR-35), on the server that serves the
 * page; `&account` after the id for a deposit of an account (KR-43). */
export function formatPairingAddress(
  pageOrigin: string,
  pairingId: string,
  key: Uint8Array,
  options: { account?: boolean } = {},
): string {
  const base = new URL("/", pageOrigin);
  const account = options.account ? "&account" : "";
  return `${base.href}?pair=${pairingId}${account}#p=${bytesToBase64Url(key)}`;
}

/** The pairing an address carries: `undefined` if it names none, a
 * rejection if it names one malformed (KR-35). */
export function readPairingAddress(
  search: string,
  hash: string,
): PairingAddress | undefined {
  const query = new URLSearchParams(search);
  const named = query.getAll("pair");
  if (named.length === 0) return undefined;
  const [pairingId = ""] = named;
  if (named.length > 1 || !ID.test(pairingId)) {
    throw new Error("a pairing id is 32 lowercase hexadecimal characters");
  }
  // KR-43: present once, and empty.
  const account = query.getAll("account");
  if (account.length > 1 || (account.length === 1 && account[0] !== "")) {
    throw new Error("`account` is present once, and empty");
  }
  const match = /^#p=([A-Za-z0-9_-]{43})$/.exec(hash);
  if (!match?.[1]) throw new Error("a pairing address carries its key");
  const key = base64UrlToBytes(match[1]);
  if (key.length !== KEY_BYTES) throw new Error("a pairing key is 32 bytes");
  return { pairingId, key, account: account.length === 1 };
}
