import { base64ToBytes, base64UrlToBytes, bytesToBase64Url, bytesToUtf8, utf8ToBytes } from "./encoding";

const AES_IV_LENGTH = 12;
const TOKEN_PAYLOAD_VERSION = "v1";

function requireBytes(value: Uint8Array, length: number, label: string): Uint8Array {
  if (value.length !== length) {
    throw new Error(`${label} must decode to ${length} bytes`);
  }
  return value;
}

async function importAesKey(base64Key: string): Promise<CryptoKey> {
  const keyBytes = validateTokenEncryptionKey(base64Key);
  return crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", utf8ToBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify"
  ]);
}

export async function encryptToken(plaintext: string, base64Key: string): Promise<string> {
  const key = await importAesKey(base64Key);
  const iv = new Uint8Array(AES_IV_LENGTH);
  crypto.getRandomValues(iv);
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, utf8ToBytes(plaintext));
  return `${TOKEN_PAYLOAD_VERSION}.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(cipher))}`;
}

export function validateTokenEncryptionKey(base64Key: string): Uint8Array {
  return requireBytes(base64ToBytes(base64Key), 32, "TOKEN_ENCRYPTION_KEY");
}

export async function decryptToken(payload: string, base64Key: string): Promise<string> {
  const [version, ivPart, cipherPart] = payload.split(".");
  if (version !== TOKEN_PAYLOAD_VERSION || !ivPart || !cipherPart) {
    throw new Error("Unsupported encrypted token payload");
  }
  const key = await importAesKey(base64Key);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlToBytes(ivPart) },
    key,
    base64UrlToBytes(cipherPart)
  );
  return bytesToUtf8(new Uint8Array(plain));
}

export async function hmacSha256Base64Url(value: string, secret: string): Promise<string> {
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, utf8ToBytes(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

export async function sha256Base64Url(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", utf8ToBytes(value));
  return bytesToBase64Url(new Uint8Array(hash));
}

export function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return result === 0;
}
