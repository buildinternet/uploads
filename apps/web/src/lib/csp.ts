/**
 * Shared CSP fragments for pages that ship a Content-Security-Policy.
 *
 * Gotchas this encodes (seen on /g/* and latent elsewhere):
 * - Astro often extracts page `<style>` into `/_astro/*.css`. `style-src
 *   'unsafe-inline'` alone blocks those stylesheets; always allow `'self'`.
 * - Cloudflare Web Analytics injects a RUM beacon. With `default-src 'none'`
 *   you must allow its script host and connect endpoint explicitly.
 */
export const CF_RUM_SCRIPT_SRC = "https://static.cloudflareinsights.com";
export const CF_RUM_CONNECT_SRC = "https://cloudflareinsights.com";

/** style-src value that survives Astro CSS extraction. */
export const STYLE_SRC_SELF_AND_INLINE = "'self' 'unsafe-inline'";
