/**
 * API key prefix for Better Auth's `@better-auth/api-key` plugin.
 *
 * Hosted uploads.sh uses `upl_sk_`. Self-hosted installs set
 * `AUTH_API_KEY_PREFIX` so their keys don't look like hosted ones.
 * Keep this file in lockstep with `apps/api/src/api-key-prefix.ts`.
 *
 * The prefix must not collide with workspace tokens (`up_<workspace>_…`).
 * `upl_sk_` is safe: it does not match `^up_[a-z0-9]`.
 */

export const DEFAULT_API_KEY_PREFIX = "upl_sk_";

const PREFIX_RE = /^[a-z][a-z0-9_-]{0,30}_$/;
const WORKSPACE_TOKEN_COLLISION_RE = /^up_([a-z0-9]|$)/;

export type ApiKeyPrefixFailure = "empty" | "invalid" | "collides_with_workspace_token";

export type ApiKeyPrefixResult =
  | { ok: true; prefix: string }
  | { ok: false; reason: ApiKeyPrefixFailure };

/** Normalize a configured prefix: trim, lowercase, append `_` if missing. */
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

/**
 * Prefix the plugin should stamp on new keys. Blank/unset → hosted default.
 * An explicitly invalid value also falls back to the default so a typo in
 * wrangler vars cannot take auth offline; the caller should log that.
 */
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
