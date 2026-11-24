const ALGORITHM = "AES-GCM";
const NONCE_BYTES = 12;

function params(nonce: Uint8Array, additionalData?: Uint8Array): AesGcmParams {
  return additionalData === undefined
    ? { name: ALGORITHM, iv: nonce as BufferSource }
    : {
        name: ALGORITHM,
        iv: nonce as BufferSource,
        additionalData: additionalData as BufferSource,
      };
}

export async function generateKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: ALGORITHM, length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

export async function exportKeyToBase64Url(key: CryptoKey): Promise<string> {
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function importKeyFromBase64Url(
  base64url: string,
): Promise<CryptoKey> {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const raw = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) raw[i] = binary.charCodeAt(i);
  return crypto.subtle.importKey("raw", raw, { name: ALGORITHM }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** K-10; with `additionalData`, K-19 (an attached image). */
export async function encrypt(
  key: CryptoKey,
  plaintext: Uint8Array,
  additionalData?: Uint8Array,
): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      params(nonce, additionalData),
      key,
      plaintext as BufferSource,
    ),
  );
  const blob = new Uint8Array(nonce.length + ciphertext.length);
  blob.set(nonce, 0);
  blob.set(ciphertext, nonce.length);
  return blob;
}

export async function decrypt(
  key: CryptoKey,
  blob: Uint8Array,
  additionalData?: Uint8Array,
): Promise<Uint8Array> {
  const nonce = blob.slice(0, NONCE_BYTES);
  const ciphertext = blob.slice(NONCE_BYTES);
  const plaintext = await crypto.subtle.decrypt(
    params(nonce, additionalData),
    key,
    ciphertext,
  );
  return new Uint8Array(plaintext);
}
