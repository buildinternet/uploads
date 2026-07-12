// Runtime Worker secrets/dev fallbacks (see .dev.vars.example), not declared
// in wrangler.jsonc, so `wrangler types` does not generate them. Augment Env
// here, mirroring apps/api/src/env.d.ts.
interface Env {
  /**
   * Dev-only fallback for the Better Auth signing secret. Preferred only when
   * UPL_BETTER_AUTH_SECRET (Secrets Store) is unresolvable — see
   * src/secrets.ts and the D7 footgun note there.
   */
  BETTER_AUTH_SECRET_DEV?: string;
  /** Dev-only plain fallbacks for GitHub OAuth, gated the same way as the store pair. */
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Comma-separated extra trusted origins (see src/trusted-origins.ts). */
  BETTER_AUTH_TRUSTED_ORIGINS?: string;
  /** Dev opt-out for Better Auth's fail-closed production rate limiting. */
  AUTH_RATE_LIMIT_DISABLED?: string;
}
