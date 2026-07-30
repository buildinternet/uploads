/**
 * Service-host crawl policy. auth.uploads.sh is the sign-in / OAuth AS —
 * not a content surface — so every bot is told to stay out. Marketing +
 * docs live on https://uploads.sh.
 *
 * Lives in its own module (not index.ts) because workerd treats every named
 * export of the main module as a potential entrypoint and refuses to start
 * when one is a plain string ("Incorrect type for map entry 'ROBOTS_TXT'").
 */
export const ROBOTS_TXT = `# https://auth.uploads.sh — auth / OAuth only; do not crawl.
# Public docs and marketing: https://uploads.sh

User-agent: *
Disallow: /
`;
