/**
 * Secret resolution for the auth worker (see plan D7, and uploads#754 item 2
 * for the completed Secrets Store → plain secret migration).
 *
 * All four auth secrets (signing secret, infra dashboard API key, GitHub
 * OAuth client id/secret) have exactly one consumer — this worker — so the
 * Cloudflare Secrets Store's cross-worker propagation never paid for itself,
 * and its `store_id` pointed at an account-level store shared across
 * buildinternet repos (non-portable for a self-hoster). They're now plain
 * per-worker secrets (`wrangler secret put BETTER_AUTH_SECRET`, etc.), read
 * synchronously off `env` like every other secret in this repo.
 *
 * These resolvers stay `async` even though resolution is now synchronous —
 * every call site already `await`s them, and keeping the shape stable avoids
 * churn at each caller. A missing secret still degrades the *feature* it
 * gates (GitHub omitted from socialProviders, signing secret unresolved →
 * 503) instead of 500ing every request.
 */

export type SigningSecretEnv = {
  BETTER_AUTH_SECRET?: string;
};

/**
 * The Better Auth signing secret. Returns null when unset — callers MUST
 * treat null as "answer 503 from /api/auth/*" rather than booting Better
 * Auth with an ephemeral secret (see {@link authGuardStatus} and
 * src/index.ts).
 */
export async function resolveSigningSecret(env: SigningSecretEnv): Promise<string | null> {
  return env.BETTER_AUTH_SECRET || null;
}

export type GitHubCredentialsEnv = {
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
};

export type GitHubCredentials = { clientId: string; clientSecret: string };

/**
 * GitHub OAuth credentials, gated: returns null unless BOTH id and secret
 * are set (D3 — "socialProviders built by a gate function").
 */
export async function resolveGitHubCredentials(
  env: GitHubCredentialsEnv,
): Promise<GitHubCredentials | null> {
  const clientId = env.GITHUB_CLIENT_ID || null;
  const clientSecret = env.GITHUB_CLIENT_SECRET || null;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export type DashApiKeyEnv = {
  BETTER_AUTH_API_KEY?: string;
};

/** Infra dashboard API key; null → omit `dash()`. */
export async function resolveDashApiKey(env: DashApiKeyEnv): Promise<string | null> {
  return env.BETTER_AUTH_API_KEY || null;
}
