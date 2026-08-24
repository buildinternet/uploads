/**
 * Better Auth `trustedOrigins` allow-list, pure and unit-tested. Mirrors the
 * shape of `~/Code/releases/workers/api/src/auth/index.ts`'s
 * `authTrustedOrigins`, trimmed to what uploads.sh actually needs: an explicit
 * uploads.sh family (the web origin + env escape hatch), plus a plain-loopback
 * allowance for local dev.
 *
 * #731/#741: the browser only ever talks to the WEB origin — auth is reached
 * same-origin through web's `/api/auth` proxy in every environment — so the
 * web origin (`env.WEB_ORIGIN`, passed through in dev too, including the
 * portless `*.localhost` and real-TLD OAuth-testing origins and any worktree
 * prefix) is always in the static list below and needs no regex. The old
 * portless / real-TLD parent-domain regexes existed to trust the now-retired
 * `auth.*` dev subdomains for cross-subdomain cookie sharing, which #731
 * removed; only the loopback convenience remains.
 */

// Non-production only: bare loopback origins on any port. Lets a developer poke
// the auth worker directly from a scratch tool on a different loopback port
// than the web dev server. `.localhost` and real-TLD dev origins are covered by
// the static WEB_ORIGIN entry instead (see the module docstring).
const LOOPBACK_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export type TrustedOriginsEnv = {
  WEB_ORIGIN?: string;
  ENVIRONMENT?: string;
  BETTER_AUTH_TRUSTED_ORIGINS?: string;
};

function extraTrustedOrigins(env: TrustedOriginsEnv): string[] {
  return (env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Static origin list for Better Auth's `trustedOrigins` option: the web
 * origin (defaults to https://uploads.sh), plus any comma-separated extras
 * from `BETTER_AUTH_TRUSTED_ORIGINS`. The non-prod loopback allowance is
 * matched dynamically in {@link isTrustedOrigin} (regex, not enumerable), so
 * it is intentionally NOT included here — Better Auth accepts a function too,
 * but we keep this list for the no-Origin fallback and any array consumer.
 */
export function authTrustedOrigins(env: TrustedOriginsEnv): string[] {
  const webOrigin = env.WEB_ORIGIN || "https://uploads.sh";
  return [...new Set([webOrigin, ...extraTrustedOrigins(env)])];
}

/** True when `origin` should be allowed to talk to the auth worker. */
export function isTrustedOrigin(origin: string, env: TrustedOriginsEnv): boolean {
  if (authTrustedOrigins(env).includes(origin)) return true;
  if (env.ENVIRONMENT === "production") return false;
  return LOOPBACK_ORIGIN_RE.test(origin);
}
