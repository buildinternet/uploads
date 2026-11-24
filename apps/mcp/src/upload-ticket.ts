/**
 * Upload tickets for `sign_upload_url` (issue #1242). A ticket is the path
 * segment of `PUT /u/<ticket>`: the `put` arguments for one file plus who
 * minted it, as an HS256 JWT so the PUT needs no bearer and no database row.
 *
 * Signed, not encrypted: anyone holding the URL can read the claims
 * (workspace, repo, filename), which is fine — the URL itself is the
 * credential, scoped to one file in one workspace for
 * {@link UPLOAD_TICKET_TTL_S}.
 *
 * The signing key is derived from `WORKSPACE_SECRETS_KEY` rather than used
 * directly, since that secret is also the AES key for stored workspace
 * credentials (`apps/api/src/secrets.ts`). `_PREVIOUS` still verifies so
 * tickets survive a key rotation.
 */
import { jwtVerify, SignJWT } from "jose";
import type { UploaderIdentity } from "@uploads/api/uploader-identity";

export const UPLOAD_TICKET_TTL_S = 15 * 60;
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
  /**
   * Set by `put`'s File Uploads flow (`file-uploads.ts`): the PUT also syncs
   * the PR comment and saves its result under this id for the retried call.
   */
  slot?: string;
  /** The minting token's file scopes, so the PUT can sync the comment. Defaults to files:write. */
  scopes?: string[];
}

interface TicketKeyEnv {
  WORKSPACE_SECRETS_KEY?: string;
  WORKSPACE_SECRETS_KEY_PREVIOUS?: string;
}

/** `HMAC(master, label)` — a key for one token kind, separate from the AES use. */
async function derivedKey(master: string, label = KEY_LABEL): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(master),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(label)));
}

/** Whether this worker can mint tickets at all. */
export function canSignUploadTickets(env: TicketKeyEnv): boolean {
  return Boolean(env.WORKSPACE_SECRETS_KEY);
}

export async function signUploadTicket(
  env: TicketKeyEnv,
  claims: UploadTicketClaims,
  now = Date.now(),
): Promise<{ ticket: string; expiresAt: string }> {
  if (!env.WORKSPACE_SECRETS_KEY) throw new Error("upload tickets are not configured");
  const iat = Math.floor(now / 1000);
  const exp = iat + UPLOAD_TICKET_TTL_S;
  const ticket = await new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(await derivedKey(env.WORKSPACE_SECRETS_KEY));
  return { ticket, expiresAt: new Date(exp * 1000).toISOString() };
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
  for (const master of [env.WORKSPACE_SECRETS_KEY, env.WORKSPACE_SECRETS_KEY_PREVIOUS]) {
    if (!master) continue;
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(ticket, await derivedKey(master), {
        algorithms: ["HS256"],
        currentDate: new Date(now),
        requiredClaims: ["exp"],
      }));
    } catch {
      continue;
    }
    const { ws, who, args, maxBytes, slot, scopes } = payload;
    if (
      typeof ws !== "string" ||
      typeof who !== "object" ||
      who === null ||
      typeof args !== "object" ||
      args === null ||
      typeof maxBytes !== "number"
    ) {
      return null;
    }
    return {
      ws,
      who: who as UploaderIdentity,
      args: args as Record<string, unknown>,
      maxBytes,
      ...(typeof slot === "string" ? { slot } : {}),
      ...(Array.isArray(scopes) ? { scopes: scopes.filter((x) => typeof x === "string") } : {}),
    };
  }
  return null;
}

const STATE_KEY_LABEL = "mcp-file-state-v1";

/** How long a File Uploads `requestState` stays valid. Outlives its 15-minute upload URL. */
export const FILE_STATE_TTL_S = 60 * 60;

/**
 * The `requestState` of a File Uploads `upload_required` result: which call
 * it belongs to (workspace, uploader, a hash of the arguments) and the slot
 * where the PUT saves its result. Signed with its own derived key, so a
 * ticket can't pass as a state or the other way round.
 */
export interface FileStateClaims {
  ws: string;
  who: UploaderIdentity;
  /** `argsDigest` of the tool arguments. */
  args: string;
  slot: string;
  /** A hint `put` adds to the result, and whether it replaces one the result has. */
  hint?: string;
  hintWins?: boolean;
}

export async function signFileState(
  env: TicketKeyEnv,
  claims: FileStateClaims,
  now = Date.now(),
): Promise<string> {
  if (!env.WORKSPACE_SECRETS_KEY) throw new Error("upload tickets are not configured");
  const iat = Math.floor(now / 1000);
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(iat)
    .setExpirationTime(iat + FILE_STATE_TTL_S)
    .sign(await derivedKey(env.WORKSPACE_SECRETS_KEY, STATE_KEY_LABEL));
}

/** Claims for a valid, unexpired state; null for anything else. */
export async function verifyFileState(
  env: TicketKeyEnv,
  state: string,
  now = Date.now(),
): Promise<FileStateClaims | null> {
  for (const master of [env.WORKSPACE_SECRETS_KEY, env.WORKSPACE_SECRETS_KEY_PREVIOUS]) {
    if (!master) continue;
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(state, await derivedKey(master, STATE_KEY_LABEL), {
        algorithms: ["HS256"],
        currentDate: new Date(now),
        requiredClaims: ["exp"],
      }));
    } catch {
      continue;
    }
    const { ws, who, args, slot, hint, hintWins } = payload;
    if (
      typeof ws !== "string" ||
      typeof who !== "object" ||
      who === null ||
      typeof args !== "string" ||
      typeof slot !== "string"
    ) {
      return null;
    }
    return {
      ws,
      who: who as UploaderIdentity,
      args,
      slot,
      ...(typeof hint === "string" ? { hint } : {}),
      ...(hintWins === true ? { hintWins } : {}),
    };
  }
  return null;
}
