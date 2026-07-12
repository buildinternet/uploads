/**
 * Secret resolution for the auth worker (see plan D7).
 *
 * Pattern copied from `~/Code/releases/workers/api/src/auth/index.ts`
 * (`resolveSecret`/`resolveSigningSecret`): a Secrets Store binding's
 * `.get()` is preferred, with a same-named plain-string env var as the dev
 * fallback, and store-resolution failures are swallowed rather than thrown —
 * a missing/misconfigured secret degrades the *feature* it gates (GitHub
 * omitted from socialProviders, signing secret unresolved → 503) instead of
 * 500ing every request.
 *
 * ⚠ footgun (D7): under `wrangler dev`, a same-named `.dev.vars` string does
 * NOT override an unpopulated Secrets Store binding — the binding still
 * "exists" and its `.get()` just rejects/returns empty. That's why the dev
 * fallback vars below are distinctly named (`BETTER_AUTH_SECRET_DEV`,
 * `BETTER_AUTH_API_KEY`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`) rather
 * than shadowing the `UPL_`-prefixed binding names.
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

export type SigningSecretEnv = {
  UPL_BETTER_AUTH_SECRET?: SecretLike;
  BETTER_AUTH_SECRET_DEV?: string;
};

/**
 * The Better Auth signing secret. Store binding wins; `BETTER_AUTH_SECRET_DEV`
 * is used only when the store value is unresolved (empty/missing/store
 * failure) — never as a silent override of a populated store entry.
 *
 * Returns null when neither resolves. Callers MUST treat null as "answer 503
 * from /api/auth/*" rather than booting Better Auth with an ephemeral secret
 * (see {@link authGuardStatus} and src/index.ts).
 */
export async function resolveSigningSecret(env: SigningSecretEnv): Promise<string | null> {
  const fromStore = await resolveSecret(env.UPL_BETTER_AUTH_SECRET);
  return fromStore || env.BETTER_AUTH_SECRET_DEV || null;
}

export type GitHubCredentialsEnv = {
  UPL_GITHUB_CLIENT_ID?: SecretLike;
  UPL_GITHUB_CLIENT_SECRET?: SecretLike;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
};

export type GitHubCredentials = { clientId: string; clientSecret: string };

/**
 * GitHub OAuth credentials, gated: returns null unless BOTH id and secret
 * resolve non-empty (D3 — "socialProviders built by a gate function"). Same
 * dev-fallback shape as {@link resolveSigningSecret}.
 */
export async function resolveGitHubCredentials(
  env: GitHubCredentialsEnv,
): Promise<GitHubCredentials | null> {
  const [clientId, clientSecret] = await Promise.all([
    resolveSecret(env.UPL_GITHUB_CLIENT_ID).then((v) => v || env.GITHUB_CLIENT_ID || null),
    resolveSecret(env.UPL_GITHUB_CLIENT_SECRET).then((v) => v || env.GITHUB_CLIENT_SECRET || null),
  ]);
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export type DashApiKeyEnv = {
  UPL_BETTER_AUTH_API_KEY?: SecretLike;
  /** Dev plain fallback (same store-vs-dev-var footgun as the signing secret). */
  BETTER_AUTH_API_KEY?: string;
};

/** Infra dashboard API key; null → omit `dash()`. Store wins over plain fallback. */
export async function resolveDashApiKey(env: DashApiKeyEnv): Promise<string | null> {
  const fromStore = await resolveSecret(env.UPL_BETTER_AUTH_API_KEY);
  return fromStore || env.BETTER_AUTH_API_KEY || null;
}
