/**
 * Service-host crawl policy. agents.uploads.sh / mcp.uploads.sh is an MCP
 * endpoint — not a content surface — so every bot is told to stay out.
 * Marketing + docs live on https://uploads.sh.
 *
 * Lives in its own module (not index.ts) because workerd treats every named
 * export of the main module as a potential entrypoint and refuses to start
 * when one is a plain string ("Incorrect type for map entry 'ROBOTS_TXT'").
 */
export const ROBOTS_TXT = `# https://agents.uploads.sh — MCP server only; do not crawl.
# Public docs and marketing: https://uploads.sh

User-agent: *
Allow: /.well-known/openai-apps-challenge
Disallow: /
`;
