/**
 * JSON catalog for /docs.json — consumed by `uploads docs` and MCP `search_docs`.
 * Titles and summaries come from the docs collection (and a few extra pages);
 * aliases are the synonyms agents actually type.
 */

const SITE = "https://uploads.sh";

export type DocsCatalogPage = {
  page: string;
  title: string;
  url: string;
  summary: string;
  aliases: string[];
};

export type DocsCatalog = {
  url: string;
  pages: DocsCatalogPage[];
};

export type DocsCatalogPageInput = {
  page: string;
  path: string;
  title: string;
  summary: string;
  aliases?: string[];
};

/** Extra search terms keyed by catalog `page` id (URL slug). */
export const DOCS_SEARCH_ALIASES: Record<string, string[]> = {
  docs: ["overview", "hub", "install"],
  "attach-pull-request-images": [
    "attach",
    "stage",
    "staging",
    "screenshot",
    "annotate",
    "pr",
    "issue",
    "before",
    "after",
    "put",
    "share",
  ],
  galleries: ["gallery", "collection"],
  feeds: ["feed", "change feed", "repo feed", "pr feed", "pull request feed", "smart gallery"],
  "github-app": ["bot", "webhook", "promote", "app", "ingest"],
  "comment-config": ["uploads.yml", "comment", "yaml", "yml", "width"],
  agents: ["mcp", "skill", "plugin", "claude", "codex"],
  reference: ["list", "delete", "usage", "visibility"],
  limits: ["plan", "plans", "pricing", "quota", "storage", "pro", "free"],
  "byo-bucket": ["r2", "s3", "byo", "bucket", "bring-your-own"],
  "github-screenshots": ["walkthrough", "agent-guide", "how-to"],
  changelog: ["updates", "release", "whats-new"],
  auth: ["login", "token", "oauth", "bearer"],
};

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value.trim());
  }
  return out;
}

export function aliasesFor(page: string, extra: string[] = []): string[] {
  return unique([...(DOCS_SEARCH_ALIASES[page] ?? []), ...extra].filter((alias) => alias !== page));
}

export function renderDocsCatalog(pages: DocsCatalogPageInput[]): DocsCatalog {
  if (pages.length === 0) {
    throw new Error("renderDocsCatalog: refusing to publish an empty catalog");
  }
  return {
    url: `${SITE}/docs`,
    pages: pages.map((page) => ({
      page: page.page,
      title: page.title,
      url: `${SITE}${page.path}`,
      summary: page.summary,
      aliases: page.aliases ?? [],
    })),
  };
}
