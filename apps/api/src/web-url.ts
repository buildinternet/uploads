/**
 * Base builder for on-site (apps/web) URLs. `WEB_ORIGIN` is a wrangler-declared
 * literal (e.g. "https://uploads.sh"); this trims a trailing slash so callers
 * can append "/g/…", "/f/…", etc. without doubling it. Single source of truth
 * for the origin — `galleryUrl` and `filePageUrl` both build on it.
 */
export function webOrigin(env: Env): string {
  return env.WEB_ORIGIN.endsWith("/") ? env.WEB_ORIGIN.slice(0, -1) : env.WEB_ORIGIN;
}
