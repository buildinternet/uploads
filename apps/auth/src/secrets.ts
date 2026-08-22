/**
 * Secret resolution for the auth worker (see plan D7, and uploads#754 item 2
 * for the Secrets Store → plain secret transition).
 *
 * All four auth secrets (signing secret, infra dashboard API key, GitHub
 * OAuth client id/secret) have exactly one consumer — this worker — so the
 * Secrets Store's cross-worker propagation never paid for itself, and its
 * `store_id` pointed at an account-level store shared across buildinternet
 * repos (non-portable for a self-hoster). The target shape is a plain
 * per-worker secret (`wrangler secret put BETTER_AUTH_SECRET`, etc.), read
 * synchronously off `env` like every other secret in this repo.
 *
 * Transition (dual-read): each resolver below prefers the plain env var when
 * it's a non-empty string, and falls back to the (still-declared, still
 * async) Secrets Store binding otherwise. This makes it safe to merge the
 * code change before an operator has run `wrangler secret put` for all
 * four — the worker keeps answering out of the store exactly as it does
 * today until the plain secrets are set, at which point they take over with
 * no further deploy required. Once an operator confirms the plain secrets
 * are live in prod (and preview, if used), a follow-up change removes the
 * `secrets_store_secrets` blocks from wrangler.jsonc and the `UPL_*`
 * fallback branches here.
 *
 * Store-resolution failures are still swallowed rather than thrown — a
 * missing/misconfigured secret degrades the *feature* it gates (GitHub
 * omitted from socialProviders, signing secret unresolved → 503) instead of
 * 500ing every request.
 */

/** Minimal shape of a Cloudflare Secrets Store binding. */
export type SecretsStoreSecret = { get: () => Promise<string> };

export type SecretLike = string | SecretsStoreSecret | undefined;

/** Resolve one Secrets Store binding (or plain string) to a value or null. */
export async function resolveSecret(value: SecretLike): Promise<string | null> {
  if (value == null) return null;
  if (typeof value === "string") return value || null;
  try {
    const resolved = await value.get();
    return resolved || null;
  } catch {
    // Store unreachable, entry not populated yet, etc. — degrade, don't throw.
    return null;
  }
}

/**
 * Resolve a value that's either a plain string (preferred) or a Secrets
 * Store binding (fallback, during the transition — see module doc).
 */
async function resolvePreferPlain(
  plain: string | undefined,
  store: SecretLike,
): Promise<string | null> {
  if (plain) return plain;
  return resolveSecret(store);
}

export type SigningSecretEnv = {
  BETTER_AUTH_SECRET?: string;
  /** Transitional Secrets Store fallback — see module doc. Removed once the
   * plain secret is confirmed live in every environment. */
  UPL_BETTER_AUTH_SECRET?: SecretLike;
};

/**
 * The Better Auth signing secret. `BETTER_AUTH_SECRET` (plain) wins; the
 * `UPL_BETTER_AUTH_SECRET` store binding is used only when the plain value is
 * unset — never as a silent override of a populated plain secret.
 *
 * Returns null when neither resolves. Callers MUST treat null as "answer 503
 * from /api/auth/*" rather than booting Better Auth with an ephemeral secret
 * (see {@link authGuardStatus} and src/index.ts).
 */
export async function resolveSigningSecret(env: SigningSecretEnv): Promise<string | null> {
  return resolvePreferPlain(env.BETTER_AUTH_SECRET, env.UPL_BETTER_AUTH_SECRET);
}

export type GitHubCredentialsEnv = {
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Transitional Secrets Store fallback — see module doc. */
  UPL_GITHUB_CLIENT_ID?: SecretLike;
  UPL_GITHUB_CLIENT_SECRET?: SecretLike;
};

export type GitHubCredentials = { clientId: string; clientSecret: string };

/**
 * GitHub OAuth credentials, gated: returns null unless BOTH id and secret
 * resolve non-empty (D3 — "socialProviders built by a gate function"). Each
 * half independently prefers its plain env var over its store fallback.
 */
export async function resolveGitHubCredentials(
  env: GitHubCredentialsEnv,
): Promise<GitHubCredentials | null> {
  const [clientId, clientSecret] = await Promise.all([
    resolvePreferPlain(env.GITHUB_CLIENT_ID, env.UPL_GITHUB_CLIENT_ID),
    resolvePreferPlain(env.GITHUB_CLIENT_SECRET, env.UPL_GITHUB_CLIENT_SECRET),
  ]);
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export type DashApiKeyEnv = {
  BETTER_AUTH_API_KEY?: string;
  /** Transitional Secrets Store fallback — see module doc. */
  UPL_BETTER_AUTH_API_KEY?: SecretLike;
};

/** Infra dashboard API key; null → omit `dash()`. Plain wins over store fallback. */
export async function resolveDashApiKey(env: DashApiKeyEnv): Promise<string | null> {
  return resolvePreferPlain(env.BETTER_AUTH_API_KEY, env.UPL_BETTER_AUTH_API_KEY);
}
