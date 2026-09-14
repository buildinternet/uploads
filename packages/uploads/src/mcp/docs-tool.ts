/**
 * Shared MCP `search_docs` surface for stdio and hosted servers.
 */
import { DEFAULT_DOCS_LIMIT, MAX_DOCS_LIMIT, searchDocs } from "../docs.js";
import { optPosInt, optString, usage, type ToolArgs } from "./args.js";

export const SEARCH_DOCS_DESCRIPTION =
  "Search the public uploads.sh documentation. Use this to answer questions about uploads.sh product workflows, including: attaching screenshots and video to GitHub PRs and issues; staging files before a PR exists; galleries; the GitHub App; comment config (.uploads.yml); hosted MCP and agent setup; screenshot capture and annotate; plans and limits; bring-your-own bucket. Same as `uploads docs`. Returns titles, URLs, and snippets. Pass `page` to fetch the full markdown of one page (slug, path, or URL). Omit `query` to list the catalog.";

export const SEARCH_DOCS_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "Search query (e.g. 'stage before a PR'). A single slug like 'attach' fetches that page.",
    },
    page: {
      type: "string",
      description:
        "Fetch one page as markdown. Accepts a slug (`attach`), path (`/docs/agents`), or https://uploads.sh URL.",
    },
    limit: {
      type: "number",
      description: `How many search hits to return (default ${DEFAULT_DOCS_LIMIT}, max ${MAX_DOCS_LIMIT}). Ignored when fetching one page.`,
    },
  },
  additionalProperties: false,
};

export async function runSearchDocsTool(args: ToolArgs) {
  const query = optString(args, "query");
  const page = optString(args, "page");
  if (query && page) usage("pass query or page, not both");
  const limit = optPosInt(args, "limit");
  if (limit !== undefined && limit > MAX_DOCS_LIMIT) {
    usage(`limit must be ${MAX_DOCS_LIMIT} or less`);
  }
  return searchDocs({ query, page, limit });
}
