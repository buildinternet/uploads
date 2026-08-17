/**
 * API key prefix detector. Keep in lockstep with
 * `apps/auth/src/api-key-prefix.ts` — both workers must agree on the
 * default and on what counts as a valid override (`AUTH_API_KEY_PREFIX`).
 *
 * Hosted uploads.sh uses `upl_sk_`. Self-hosted installs set the same
 * env var on auth, api, and mcp so generated keys are recognized here.
 */

export const DEFAULT_API_KEY_PREFIX = "upl_sk_";

const PREFIX_RE = /^[a-z][a-z0-9_-]{0,30}_$/;
const WORKSPACE_TOKEN_COLLISION_RE = /^up_([a-z0-9]|$)/;

export type ApiKeyPrefixFailure = "empty" | "invalid" | "collides_with_workspace_token";

export type ApiKeyPrefixResult =
  | { ok: true; prefix: string }
  | { ok: false; reason: ApiKeyPrefixFailure };

export function normalizeApiKeyPrefix(raw: string | undefined | null): ApiKeyPrefixResult {
  const trimmed = (raw ?? "").trim().toLowerCase();
  if (!trimmed) return { ok: false, reason: "empty" };
  const prefix = trimmed.endsWith("_") ? trimmed : `${trimmed}_`;
  if (!PREFIX_RE.test(prefix)) return { ok: false, reason: "invalid" };
  if (WORKSPACE_TOKEN_COLLISION_RE.test(prefix)) {
    return { ok: false, reason: "collides_with_workspace_token" };
  }
  return { ok: true, prefix };
}

export function resolveApiKeyPrefix(raw: string | undefined | null): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return DEFAULT_API_KEY_PREFIX;
  const result = normalizeApiKeyPrefix(trimmed);
  if (!result.ok) {
    console.error(
      JSON.stringify({
        message: "auth_api_key_prefix_invalid",
        reason: result.reason,
        fallback: DEFAULT_API_KEY_PREFIX,
      }),
    );
    return DEFAULT_API_KEY_PREFIX;
  }
  return result.prefix;
}

export function isApiKeyToken(token: string, prefix: string): boolean {
  return Boolean(token) && Boolean(prefix) && token.startsWith(prefix);
}
