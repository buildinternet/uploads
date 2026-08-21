/**
 * Service-host crawl policy. This worker is the auth / OAuth backend, served
 * to browsers same-origin at https://uploads.sh/api/auth/* and directly at
 * auth.uploads.sh for machine callers (CLI device/bearer flows, internal
 * service bindings) — not a content surface — so every bot is told to stay
 * out. Marketing + docs live on https://uploads.sh.
 *
 * Lives in its own module (not index.ts) because workerd treats every named
 * export of the main module as a potential entrypoint and refuses to start
 * when one is a plain string ("Incorrect type for map entry 'ROBOTS_TXT'").
 */
export const ROBOTS_TXT = `# auth / OAuth backend only; do not crawl.
# Public docs and marketing: https://uploads.sh

User-agent: *
Disallow: /
`;
