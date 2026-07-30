/**
 * Service-host crawl policy. api.uploads.sh is a REST API — not a content
 * surface — so every bot is told to stay out. Marketing + docs live on
 * https://uploads.sh (which has its own, more open robots.txt).
 *
 * Lives in its own module (not index.ts) because workerd treats every named
 * export of the main module as a potential entrypoint and refuses to start
 * when one is a plain string ("Incorrect type for map entry 'ROBOTS_TXT'").
 */
export const ROBOTS_TXT = `# https://api.uploads.sh — REST API only; do not crawl.
# Public docs and marketing: https://uploads.sh

User-agent: *
Disallow: /
`;
