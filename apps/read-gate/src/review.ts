/**
 * Reviewer links: `?review=<expiry>.<sig>` on a hosted URL lets a blocked
 * key through for a few minutes. uploads-api mints them for workspace
 * members (`reviewUrl` in `apps/api/src/read-gate.ts`). `sig` is
 * base64url HMAC-SHA256 over `lane \n object key \n expiry` with
 * `READ_GATE_REVIEW_SECRET`, which both Workers hold. `expiry` is unix
 * seconds. A link that claims to live longer than `MAX_REVIEW_TTL_SECONDS`
 * is refused, so a leaked secret still can't mint a lasting link.
 */

export const REVIEW_PARAM = "review";

/** Same lifetime cap as `REVIEW_URL_TTL_SECONDS` in apps/api/src/read-gate.ts, plus slack for clock skew. */
export const MAX_REVIEW_TTL_SECONDS = 15 * 60;

const encoder = new TextEncoder();

function base64url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

function message(lane: string, objectKey: string, expiry: number): Uint8Array {
  return encoder.encode(`${lane}\n${objectKey}\n${expiry}`);
}

/** `<expiry>.<sig>` for tests. The API has its own copy. */
export async function signReview(
  secret: string,
  lane: string,
  objectKey: string,
  expiry: number,
): Promise<string> {
  const sig = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, "sign"),
    message(lane, objectKey, expiry),
  );
  return `${expiry}.${base64url(sig)}`;
}

/** True when `token` is an unexpired signature for this lane and key. */
export async function verifyReview(
  secret: string | undefined,
  token: string | null,
  lane: string,
  objectKey: string,
  nowSeconds: number,
): Promise<boolean> {
  if (!secret || !token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const expiryText = token.slice(0, dot);
  if (!/^\d{1,12}$/.test(expiryText)) return false;
  const expiry = Number(expiryText);
  if (expiry <= nowSeconds || expiry > nowSeconds + MAX_REVIEW_TTL_SECONDS) return false;
  const sig = fromBase64url(token.slice(dot + 1));
  if (!sig) return false;
  try {
    return await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret, "verify"),
      sig,
      message(lane, objectKey, expiry),
    );
  } catch {
    return false;
  }
}
