/**
 * Sealing for Slack credentials at rest, plus the HMAC helper the OAuth
 * state parameter uses.
 *
 * Tokens use the same envelope as workspace BYO credentials in apps/api
 * (src/secrets.ts): `enc:v1:` + base64url(iv || AES-GCM ciphertext+tag), key
 * = SHA-256 of the master secret. This worker has its own master,
 * SLACK_TOKENS_KEY, so a leak of one key never opens the other's data.
 */

const PREFIX = "enc:v1:";
const MIN_KEY_LENGTH = 16;

export class TokensKeyUnconfiguredError extends Error {
  constructor() {
    super("SLACK_TOKENS_KEY is unset or shorter than 16 characters");
    this.name = "TokensKeyUnconfiguredError";
  }
}

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function requireKey(master: string | undefined): string {
  if (!master || master.length < MIN_KEY_LENGTH) throw new TokensKeyUnconfiguredError();
  return master;
}

async function aesKey(master: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(master));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Encrypts `plaintext` under `master`. Throws when the key is unset. */
export async function seal(master: string | undefined, plaintext: string): Promise<string> {
  const key = await aesKey(requireKey(master));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  return PREFIX + b64urlEncode(packed);
}

/** Decrypts a value from {@link seal}. Throws on a wrong key or a tampered value. */
export async function open(master: string | undefined, sealed: string): Promise<string> {
  if (!sealed.startsWith(PREFIX)) throw new Error("not a sealed value");
  const packed = b64urlDecode(sealed.slice(PREFIX.length));
  if (packed.length < 13) throw new Error("invalid sealed value");
  const key = await aesKey(requireKey(master));
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: packed.slice(0, 12) },
    key,
    packed.slice(12),
  );
  return new TextDecoder().decode(plain);
}

/** HMAC-SHA256 of `message`, base64url. `label` keeps derived uses of one master apart. */
export async function hmac(master: string | undefined, label: string, message: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`${label}:${requireKey(master)}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return b64urlEncode(new Uint8Array(mac));
}

/** Constant-time string comparison for MACs and nonces. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function randomToken(bytes = 24): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}
