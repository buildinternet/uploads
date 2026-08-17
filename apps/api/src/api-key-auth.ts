/**
 * Verify a Better Auth API key over the AUTH service binding and map it onto
 * the same workspace vars `workspaceAuth` sets for `up_` tokens.
 *
 * The plugin's `/api-key/verify` route is server-only, so this calls the
 * binding-only `POST /internal/api-keys/verify` on apps/auth.
 */
import { ServiceUnavailableError } from "@uploads/errors";
import { type FileScope } from "./auth-db";
import { membershipsForUser } from "./org-workspaces";

const AUTH_INTERNAL_ORIGIN = "https://auth.internal";

function internalHeaders(): Headers {
  return new Headers({
    "x-uploads-internal": "1",
    "content-type": "application/json",
  });
}

export interface VerifiedApiKey {
  userId: string;
  scopes: FileScope[];
}

interface VerifyResponse {
  valid?: unknown;
  userId?: unknown;
  permissions?: unknown;
}

/** Default scopes when the key has no `files` permission list (plugin default). */
const DEFAULT_API_KEY_SCOPES: FileScope[] = ["files:read", "files:write"];

export function scopesFromApiKeyPermissions(permissions: unknown): FileScope[] {
  if (permissions === null || permissions === undefined) return [...DEFAULT_API_KEY_SCOPES];
  if (typeof permissions !== "object" || Array.isArray(permissions)) return [];
  const files = (permissions as Record<string, unknown>).files;
  if (!Array.isArray(files)) return [];
  const out: FileScope[] = [];
  for (const action of files) {
    if (action === "read") out.push("files:read");
    else if (action === "write") out.push("files:write");
    else if (action === "delete") out.push("files:delete");
  }
  return [...new Set(out)];
}

/** Verify the key only — no workspace membership check. */
export async function verifyApiKey(env: Env, token: string): Promise<VerifiedApiKey | null> {
  if (!env.AUTH) return null;

  let response: Response;
  try {
    response = await env.AUTH.fetch(`${AUTH_INTERNAL_ORIGIN}/internal/api-keys/verify`, {
      method: "POST",
      headers: internalHeaders(),
      body: JSON.stringify({ key: token }),
    });
  } catch {
    throw new ServiceUnavailableError("auth service is unavailable", {
      code: "auth_api_key_unavailable",
    });
  }

  if (response.status === 400) return null;
  if (!response.ok) {
    throw new ServiceUnavailableError("auth service is unavailable", {
      code: "auth_api_key_unavailable",
      details: { status: response.status },
    });
  }

  const body = (await response.json().catch(() => undefined)) as VerifyResponse | undefined;
  if (!body || body.valid !== true || typeof body.userId !== "string" || !body.userId) {
    return null;
  }

  const scopes = scopesFromApiKeyPermissions(body.permissions);
  if (scopes.length === 0) return null;
  return { userId: body.userId, scopes };
}

/**
 * Verify `token` and confirm its owner is a member of `workspace`. Returns
 * null for an invalid key or a non-member (caller 401s uniformly). Auth
 * outages stay 503 — same posture as sessionAuth.
 */
export async function authenticateApiKey(
  env: Env,
  token: string,
  workspace: string,
): Promise<VerifiedApiKey | null> {
  const verified = await verifyApiKey(env, token);
  if (!verified) return null;
  const memberships = await membershipsForUser(env, verified.userId, { slug: workspace });
  if (memberships.length === 0) return null;
  return verified;
}
