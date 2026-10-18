/**
 * Slack request signing (v0): https://api.slack.com/authentication/verifying-requests-from-slack
 *
 * Every request Slack sends (Events API, and later slash commands and
 * interactivity) carries `X-Slack-Request-Timestamp` and `X-Slack-Signature`.
 * The signature is `v0=` + hex HMAC-SHA256 of `v0:<timestamp>:<raw body>`
 * keyed with the app's signing secret. Verify against the raw body bytes,
 * before parsing, and reject stale timestamps to stop replays.
 */

/** Slack's documented replay window. */
export const MAX_SKEW_SECONDS = 60 * 5;

export interface SignatureInput {
  signingSecret: string;
  timestamp: string | undefined | null;
  signature: string | undefined | null;
  rawBody: string;
  /** Seconds since the epoch. Injectable for tests. */
  nowSeconds?: number;
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

/**
 * True when the request is signed by Slack with `signingSecret` and is
 * fresh. Uses `crypto.subtle.verify`, which compares in constant time.
 */
export async function verifySlackSignature(input: SignatureInput): Promise<boolean> {
  const { signingSecret, timestamp, signature, rawBody } = input;
  if (!signingSecret || !timestamp || !signature) return false;
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > MAX_SKEW_SECONDS) return false;

  if (!signature.startsWith("v0=")) return false;
  const expected = hexToBytes(signature.slice(3));
  if (!expected || expected.length !== 32) return false;

  const key = await hmacKey(signingSecret, "verify");
  const message = new TextEncoder().encode(`v0:${timestamp}:${rawBody}`);
  return crypto.subtle.verify("HMAC", key, expected, message);
}

/** Signs a body the way Slack does. Used by tests and local smoke scripts. */
export async function signSlackRequest(
  signingSecret: string,
  timestamp: string,
  rawBody: string,
): Promise<string> {
  const key = await hmacKey(signingSecret, "sign");
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${timestamp}:${rawBody}`),
  );
  const hex = Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
  return `v0=${hex}`;
}
