/**
 * Encrypt workspace BYO credentials at rest in KV.
 * Form: `enc:v1:<base64url(iv || ciphertext)>` (AES-GCM-256).
 * Plaintext (no prefix) still accepted for migration. Master: WORKSPACE_SECRETS_KEY.
 */

const PREFIX = "enc:v1:";

function b64urlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function aesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(PREFIX);
}

export async function encryptSecret(masterSecret: string, plaintext: string): Promise<string> {
  if (masterSecret.length < 16) {
    throw new Error("WORKSPACE_SECRETS_KEY must be at least 16 characters");
  }
  const key = await aesKey(masterSecret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const packed = new Uint8Array(iv.length + ct.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(ct), iv.length);
  return PREFIX + b64urlEncode(packed);
}

export async function decryptSecret(
  masterSecret: string | undefined,
  value: string,
): Promise<string> {
  if (!isEncryptedSecret(value)) return value;
  if (!masterSecret || masterSecret.length < 16) {
    throw new Error("encrypted credential requires WORKSPACE_SECRETS_KEY");
  }
  const packed = b64urlDecode(value.slice(PREFIX.length));
  if (packed.length < 13) throw new Error("invalid encrypted credential");
  const iv = packed.subarray(0, 12);
  const data = packed.subarray(12);
  const key = await aesKey(masterSecret);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return new TextDecoder().decode(pt);
}

export async function sealCredentialFields(
  masterSecret: string | undefined,
  fields: { accessKeyId?: string; secretAccessKey?: string },
): Promise<{ accessKeyId?: string; secretAccessKey?: string }> {
  if (!masterSecret) return fields;
  const out = { ...fields };
  if (fields.accessKeyId && !isEncryptedSecret(fields.accessKeyId)) {
    out.accessKeyId = await encryptSecret(masterSecret, fields.accessKeyId);
  }
  if (fields.secretAccessKey && !isEncryptedSecret(fields.secretAccessKey)) {
    out.secretAccessKey = await encryptSecret(masterSecret, fields.secretAccessKey);
  }
  return out;
}

export async function openCredentialFields(
  masterSecret: string | undefined,
  fields: { accessKeyId?: string; secretAccessKey?: string },
): Promise<{ accessKeyId?: string; secretAccessKey?: string }> {
  return {
    accessKeyId: fields.accessKeyId
      ? await decryptSecret(masterSecret, fields.accessKeyId)
      : undefined,
    secretAccessKey: fields.secretAccessKey
      ? await decryptSecret(masterSecret, fields.secretAccessKey)
      : undefined,
  };
}
