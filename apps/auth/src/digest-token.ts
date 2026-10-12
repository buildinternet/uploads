/**
 * HMAC tokens for one-click digest unsubscribe. Signed with the existing
 * Better Auth secret so the link does not need a new credential or a login.
 * Payload is `v.u.k.e` JSON: version, user id, kinds, expiry (unix seconds).
 */
import { resolveSigningSecret, type SigningSecretEnv } from "./secrets";

export const DIGEST_KINDS = ["digest", "workspace"] as const;
export type DigestUnsubscribeKind = (typeof DIGEST_KINDS)[number];

const TOKEN_VERSION = 1;
const TOKEN_TTL_S = 90 * 24 * 60 * 60;

export interface DigestUnsubscribeClaims {
  userId: string;
  kinds: DigestUnsubscribeKind[];
  exp: number;
}

function bytesToB64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64UrlToBytes(value: string): Uint8Array | null {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function isKind(value: unknown): value is DigestUnsubscribeKind {
  return value === "digest" || value === "workspace";
}

async function hmac(secret: string, payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return new Uint8Array(sig);
}

// Hand-rolled rather than `crypto.subtle.timingSafeEqual`: that API is a
// Workers-only extension, and this HMAC check has to run under plain-Node
// vitest (same reason as the GitHub webhook verifier).
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export async function signDigestUnsubscribe(
  secret: string,
  userId: string,
  kinds: DigestUnsubscribeKind[],
  now = new Date(),
): Promise<string> {
  const unique = [...new Set(kinds.filter(isKind))].sort();
  if (!userId || unique.length === 0) throw new Error("digest unsubscribe needs a user and a kind");
  const payload = JSON.stringify({
    v: TOKEN_VERSION,
    u: userId,
    k: unique,
    e: Math.floor(now.getTime() / 1000) + TOKEN_TTL_S,
  });
  const sig = await hmac(secret, payload);
  return `${bytesToB64Url(new TextEncoder().encode(payload))}.${bytesToB64Url(sig)}`;
}

export async function verifyDigestUnsubscribe(
  secret: string,
  token: string,
  now = new Date(),
): Promise<DigestUnsubscribeClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const payloadBytes = b64UrlToBytes(parts[0]);
  const sigBytes = b64UrlToBytes(parts[1]);
  if (!payloadBytes || !sigBytes) return null;
  const payload = new TextDecoder().decode(payloadBytes);
  const expected = await hmac(secret, payload);
  if (!timingSafeEqual(expected, sigBytes)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { v, u, k, e } = parsed as { v?: unknown; u?: unknown; k?: unknown; e?: unknown };
  if (v !== TOKEN_VERSION || typeof u !== "string" || !u) return null;
  if (typeof e !== "number" || !Number.isFinite(e) || e < Math.floor(now.getTime() / 1000))
    return null;
  if (!Array.isArray(k) || k.length === 0 || !k.every(isKind)) return null;
  return { userId: u, kinds: [...new Set(k)], exp: e };
}

export function unsubscribeUrl(base: string, token: string): string {
  const origin = base.replace(/\/$/, "");
  return `${origin}/digest/unsubscribe?token=${encodeURIComponent(token)}`;
}

/**
 * Production mail links the auth worker's direct host. The web origin proxies
 * `/api/auth` only, so `BETTER_AUTH_URL` is the wrong place for this route.
 */
export function digestUnsubscribeBase(env: {
  AUTH_DIRECT_ORIGIN?: string;
  ENVIRONMENT?: string;
}): string {
  if (env.AUTH_DIRECT_ORIGIN) return env.AUTH_DIRECT_ORIGIN.replace(/\/$/, "");
  if (env.ENVIRONMENT === "production") return "https://auth.uploads.sh";
  return "http://127.0.0.1:8788";
}

export async function signingSecret(env: SigningSecretEnv): Promise<string | null> {
  return resolveSigningSecret(env);
}
