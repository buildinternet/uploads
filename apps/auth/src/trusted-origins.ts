/**
 * Better Auth `trustedOrigins` + CORS allow-list, pure and unit-tested (see
 * plan D1/D3). Mirrors the shape of `~/Code/releases/workers/api/src/auth/index.ts`'s
 * `authTrustedOrigins`, trimmed to what uploads.sh actually needs: no glob
 * matching (we don't have a wildcard subdomain product surface yet), just an
 * explicit uploads.sh family + portless/localhost dev origins + an env escape
 * hatch.
 */

const LOCALHOST_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
// Portless dev (see the `portless` skill): named `*.localhost` origins, e.g.
// https://uploads.localhost, https://auth.uploads.localhost, a worktree-
// prefixed https://fix-ui.uploads.localhost, or the sudo-less proxy fallback
// http://uploads.localhost:1355. `.localhost` resolves to loopback by spec.
const PORTLESS_ORIGIN_RE = /^https?:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.localhost(:\d+)?$/;
// Real-TLD portless mode for OAuth providers that reject `*.localhost`
// redirect URIs (see the `oauth` skill): PORTLESS_TLD=dev
// PORTLESS_NAME=uploads.local.buildinternet serves
// https://uploads.local.buildinternet.dev + subdomains, resolved to loopback
// via public DNS. Deliberately on the shared infra domain (matching the
// sibling repos) rather than under uploads.sh, so prod's `Domain=.uploads.sh`
// session cookies never overlap the local zone. Non-production only.
const LOCAL_BUILDINTERNET_ORIGIN_RE =
  /^https:\/\/([a-z0-9-]+\.)*uploads\.local\.buildinternet\.dev$/;

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
 * from `BETTER_AUTH_TRUSTED_ORIGINS`. Dev/localhost origins are matched
 * dynamically in {@link isTrustedOrigin} (regex, not enumerable), so they are
 * intentionally NOT included here — Better Auth accepts a function too, but
 * we keep this list for callers (e.g. CORS) that want a concrete array.
 */
export function authTrustedOrigins(env: TrustedOriginsEnv): string[] {
  const webOrigin = env.WEB_ORIGIN || "https://uploads.sh";
  return [...new Set([webOrigin, ...extraTrustedOrigins(env)])];
}

/** True when `origin` should be allowed to talk to the auth worker. */
export function isTrustedOrigin(origin: string, env: TrustedOriginsEnv): boolean {
  if (authTrustedOrigins(env).includes(origin)) return true;
  if (env.ENVIRONMENT === "production") return false;
  return (
    LOCALHOST_ORIGIN_RE.test(origin) ||
    PORTLESS_ORIGIN_RE.test(origin) ||
    LOCAL_BUILDINTERNET_ORIGIN_RE.test(origin)
  );
}
