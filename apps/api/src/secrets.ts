/**
 * Encrypt workspace BYO credentials at rest in KV.
 *
 * Form: `enc:v1:<base64url(iv || ciphertext||tag)>` (AES-GCM-256).
 * Plaintext (no prefix) still accepted for migration.
 *
 * Key ring (good practice for rotation):
 * - WORKSPACE_SECRETS_KEY — current KEK; all new seals use this
 * - WORKSPACE_SECRETS_KEY_PREVIOUS — optional; decrypt tries current then previous
 *
 * Rotate: put old → PREVIOUS, put new → KEY, run reencrypt-workspace-secrets.mjs,
 * then remove PREVIOUS after verification.
 */

const PREFIX = "enc:v1:";

/** Current + optional previous master secrets for decrypt during rotation. */
export type SecretsKeyRing = {
  current?: string;
  previous?: string;
};

export function secretsKeyRingFromEnv(env: {
  WORKSPACE_SECRETS_KEY?: string;
  WORKSPACE_SECRETS_KEY_PREVIOUS?: string;
}): SecretsKeyRing {
  return {
    current: env.WORKSPACE_SECRETS_KEY,
    previous: env.WORKSPACE_SECRETS_KEY_PREVIOUS,
  };
}

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

function assertMaster(secret: string, label: string): void {
  if (secret.length < 16) {
    throw new Error(`${label} must be at least 16 characters`);
  }
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** Encrypt with the **current** master only. */
export async function encryptSecret(masterSecret: string, plaintext: string): Promise<string> {
  assertMaster(masterSecret, "WORKSPACE_SECRETS_KEY");
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

/**
 * Decrypt a single secret value.
 * - Plaintext: returned as-is
 * - Encrypted: try ring.current, then ring.previous
 * @returns plaintext and whether the previous key was required
 */
export async function decryptSecret(
  ring: SecretsKeyRing | string | undefined,
  value: string,
): Promise<{ plaintext: string; usedPrevious: boolean }> {
  if (!isEncryptedSecret(value)) {
    return { plaintext: value, usedPrevious: false };
  }

  const candidates: { secret: string; previous: boolean }[] = [];
  if (typeof ring === "string") {
    if (ring) candidates.push({ secret: ring, previous: false });
  } else if (ring) {
    if (ring.current) candidates.push({ secret: ring.current, previous: false });
    if (ring.previous && ring.previous !== ring.current) {
      candidates.push({ secret: ring.previous, previous: true });
    }
  }

  if (candidates.length === 0) {
    throw new Error("encrypted credential requires WORKSPACE_SECRETS_KEY");
  }

  const packed = b64urlDecode(value.slice(PREFIX.length));
  if (packed.length < 13) throw new Error("invalid encrypted credential");
  const iv = packed.subarray(0, 12);
  const data = packed.subarray(12);

  let lastErr: unknown;
  for (const { secret, previous } of candidates) {
    try {
      assertMaster(secret, previous ? "WORKSPACE_SECRETS_KEY_PREVIOUS" : "WORKSPACE_SECRETS_KEY");
      const key = await aesKey(secret);
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
      return { plaintext: new TextDecoder().decode(pt), usedPrevious: previous };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("failed to decrypt credential with current or previous key");
}

/** Seal plaintext fields with the **current** master. Already-encrypted values left as-is. */
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

/**
 * Decrypt fields with the key ring. `usedPrevious` is true if either field
 * needed the previous master (caller may re-seal with current).
 */
export async function openCredentialFields(
  ring: SecretsKeyRing | string | undefined,
  fields: { accessKeyId?: string; secretAccessKey?: string },
): Promise<{
  accessKeyId?: string;
  secretAccessKey?: string;
  usedPrevious: boolean;
}> {
  let usedPrevious = false;
  let accessKeyId: string | undefined;
  let secretAccessKey: string | undefined;

  if (fields.accessKeyId) {
    const r = await decryptSecret(ring, fields.accessKeyId);
    accessKeyId = r.plaintext;
    if (r.usedPrevious) usedPrevious = true;
  }
  if (fields.secretAccessKey) {
    const r = await decryptSecret(ring, fields.secretAccessKey);
    secretAccessKey = r.plaintext;
    if (r.usedPrevious) usedPrevious = true;
  }

  return { accessKeyId, secretAccessKey, usedPrevious };
}

/**
 * Decrypt with ring (current + previous), then seal with **current** only.
 * Use after rotation to rewrite KV under the new KEK.
 */
export async function resealCredentialFields(
  ring: SecretsKeyRing,
  fields: { accessKeyId?: string; secretAccessKey?: string },
): Promise<{ accessKeyId?: string; secretAccessKey?: string; changed: boolean }> {
  if (!ring.current) {
    throw new Error("reseal requires WORKSPACE_SECRETS_KEY (current)");
  }
  const opened = await openCredentialFields(ring, fields);
  const out: { accessKeyId?: string; secretAccessKey?: string } = {};
  if (opened.accessKeyId !== undefined) {
    out.accessKeyId = await encryptSecret(ring.current, opened.accessKeyId);
  }
  if (opened.secretAccessKey !== undefined) {
    out.secretAccessKey = await encryptSecret(ring.current, opened.secretAccessKey);
  }
  const changed =
    out.accessKeyId !== fields.accessKeyId || out.secretAccessKey !== fields.secretAccessKey;
  return { ...out, changed };
}
