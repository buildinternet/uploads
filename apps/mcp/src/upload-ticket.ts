/**
 * Upload tickets for `sign_upload_url` (issue #1242). A ticket is the path
 * segment of `PUT /u/<ticket>`: the `put` arguments for one file plus who
 * minted it, HMAC-signed so the PUT needs no bearer and no database row.
 *
 * Form: `<b64url(JSON claims)>.<b64url(HMAC-SHA256)>`. Signed, not
 * encrypted: anyone holding the URL can read the claims (workspace, repo,
 * filename), which is fine — the URL itself is the credential, scoped to one
 * file in one workspace for {@link UPLOAD_TICKET_TTL_S}.
 *
 * The signing key is derived from `WORKSPACE_SECRETS_KEY` rather than used
 * directly, since that secret is also the AES key for stored workspace
 * credentials (`apps/api/src/secrets.ts`). `_PREVIOUS` still verifies so
 * tickets survive a key rotation.
 */
import type { UploaderIdentity } from "@uploads/api/uploader-identity";

export const UPLOAD_TICKET_TTL_S = 15 * 60;
const TICKET_VERSION = 1;
const KEY_LABEL = "upload-ticket-v1";

export interface UploadTicketClaims {
  /** Workspace the upload lands in. */
  ws: string;
  /** Who minted the ticket — the upload is attributed to them. */
  who: UploaderIdentity;
  /** `put` arguments for exactly one file (`filename` set, no content). */
  args: Record<string, unknown>;
  /** Byte ceiling for the body, checked against Content-Length. */
  maxBytes: number;
  iat: number;
  exp: number;
}

interface TicketKeyEnv {
  WORKSPACE_SECRETS_KEY?: string;
  WORKSPACE_SECRETS_KEY_PREVIOUS?: string;
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
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data)),
  );
}

/** `HMAC(master, "upload-ticket-v1")` — a ticket-only key, separate from the AES use. */
function ticketKey(master: string): Promise<Uint8Array> {
  return hmac(new TextEncoder().encode(master), KEY_LABEL);
}

// Hand-rolled for the same reason as apps/auth/src/digest-token.ts: tests run
// under plain Node, where crypto.subtle.timingSafeEqual doesn't exist.
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Whether this worker can mint tickets at all. */
export function canSignUploadTickets(env: TicketKeyEnv): boolean {
  return Boolean(env.WORKSPACE_SECRETS_KEY);
}

export async function signUploadTicket(
  env: TicketKeyEnv,
  claims: Omit<UploadTicketClaims, "iat" | "exp">,
  now = Date.now(),
): Promise<{ ticket: string; expiresAt: string }> {
  if (!env.WORKSPACE_SECRETS_KEY) throw new Error("upload tickets are not configured");
  const iat = Math.floor(now / 1000);
  const exp = iat + UPLOAD_TICKET_TTL_S;
  const payload = bytesToB64Url(
    new TextEncoder().encode(JSON.stringify({ v: TICKET_VERSION, ...claims, iat, exp })),
  );
  const sig = await hmac(await ticketKey(env.WORKSPACE_SECRETS_KEY), payload);
  return {
    ticket: `${payload}.${bytesToB64Url(sig)}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

/**
 * Claims for a valid, unexpired ticket; null for anything else (bad shape,
 * bad signature, expired). Callers answer every null the same way so the
 * response doesn't say which check failed.
 */
export async function verifyUploadTicket(
  env: TicketKeyEnv,
  ticket: string,
  now = Date.now(),
): Promise<UploadTicketClaims | null> {
  const [payload, sigPart, extra] = ticket.split(".");
  if (!payload || !sigPart || extra !== undefined) return null;
  const sig = b64UrlToBytes(sigPart);
  if (!sig) return null;

  let signed = false;
  for (const master of [env.WORKSPACE_SECRETS_KEY, env.WORKSPACE_SECRETS_KEY_PREVIOUS]) {
    if (master && timingSafeEqual(sig, await hmac(await ticketKey(master), payload))) {
      signed = true;
      break;
    }
  }
  if (!signed) return null;

  const json = b64UrlToBytes(payload);
  if (!json) return null;
  let claims: Partial<UploadTicketClaims> & { v?: unknown };
  try {
    claims = JSON.parse(new TextDecoder().decode(json)) as typeof claims;
  } catch {
    return null;
  }
  if (
    claims.v !== TICKET_VERSION ||
    typeof claims.ws !== "string" ||
    typeof claims.who !== "object" ||
    claims.who === null ||
    typeof claims.args !== "object" ||
    claims.args === null ||
    typeof claims.maxBytes !== "number" ||
    typeof claims.iat !== "number" ||
    typeof claims.exp !== "number"
  ) {
    return null;
  }
  if (Math.floor(now / 1000) >= claims.exp) return null;
  return {
    ws: claims.ws,
    who: claims.who,
    args: claims.args,
    maxBytes: claims.maxBytes,
    iat: claims.iat,
    exp: claims.exp,
  };
}
