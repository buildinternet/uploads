/**
 * Fetch and search the public uploads.sh docs catalog for `uploads docs`
 * and the MCP `search_docs` tool.
 */
import { UploadsError } from "./errors.js";
import { packageVersion } from "./package-version.js";

export const DOCS_HUB_URL = "https://uploads.sh/docs";
export const DOCS_JSON_URL = "https://uploads.sh/docs.json";
export const DEFAULT_DOCS_LIMIT = 5;
export const MAX_DOCS_LIMIT = 50;
export const DOCS_SNIPPET_MAX_CHARS = 1500;
export const DOCS_PAGE_MAX_CHARS = 50_000;

const FETCH_TIMEOUT_MS = 8000;
const SITE_ORIGIN = "https://uploads.sh";

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "do",
  "for",
  "how",
  "i",
  "in",
  "is",
  "my",
  "of",
  "on",
  "or",
  "the",
  "to",
  "we",
  "your",
]);

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

export type DocsSearchHit = {
  title: string;
  url: string;
  page: string;
  snippet: string;
  body?: string;
  truncated?: boolean;
};

export type DocsSearchDocument = {
  url: string;
  query?: string;
  results: DocsSearchHit[];
  total: number;
};

export type SearchDocsOptions = {
  query?: string;
  page?: string;
  limit?: number;
  url?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
  /** Skip the network catalog fetch (tests). */
  catalog?: DocsCatalog;
};

/** Built-in catalog used when /docs.json is unreachable. */
export const FALLBACK_DOCS_CATALOG: DocsCatalog = {
  url: DOCS_HUB_URL,
  pages: [
    {
      page: "docs",
      title: "Docs",
      url: "https://uploads.sh/docs",
      summary:
        "Install the uploads CLI, attach screenshots and video to GitHub PRs, issues, and code reviews, and set up your agent.",
      aliases: ["overview", "hub", "install"],
    },
    {
      page: "attach-pull-request-images",
      title: "Attach & share",
      url: "https://uploads.sh/docs/attach-pull-request-images",
      summary:
        "Attach screenshots and video to GitHub PRs and issues, stage them before a PR exists, pair a before and after, and get a public URL for any accepted file with the uploads CLI.",
      aliases: ["attach", "stage", "staging", "pr", "issue", "before", "after", "put", "share"],
    },
    {
      page: "capture",
      title: "Capture & annotate",
      url: "https://uploads.sh/docs/capture",
      summary:
        "Capture a screenshot of a URL or local HTML file and host it in one step, then bake boxes, labels, and redactions onto it with the uploads CLI.",
      aliases: ["screenshot", "capture", "annotate", "redact", "callout"],
    },
    {
      page: "galleries",
      title: "Galleries",
      url: "https://uploads.sh/docs/galleries",
      summary:
        "Create an ordered set of media behind one public link at /g/<id>, add files with uploads put --gallery, and link the gallery to a PR or issue.",
      aliases: ["gallery", "collection"],
    },
    {
      page: "github-app",
      title: "GitHub App",
      url: "https://uploads.sh/docs/github-app",
      summary:
        "Install the uploads-sh GitHub App so attachment comments post as the bot, private-repo PR and issue titles show on file pages, and titles stay current.",
      aliases: ["bot", "webhook", "promote", "app", "ingest"],
    },
    {
      page: "comment-config",
      title: "Comment config",
      url: "https://uploads.sh/docs/comment-config",
      summary:
        "Reference for .uploads.yml — a repo-committed file that controls image width, inline-image caps, caption metadata, and an optional note on the managed PR/issue comment.",
      aliases: ["uploads.yml", "comment", "yaml", "yml", "width"],
    },
    {
      page: "agents",
      title: "Set up your agent",
      url: "https://uploads.sh/docs/agents",
      summary:
        "Install the uploads agent skill and MCP server so your coding agent can attach screenshots to GitHub on its own.",
      aliases: ["mcp", "skill", "plugin", "claude", "codex"],
    },
    {
      page: "reference",
      title: "Reference",
      url: "https://uploads.sh/docs/reference",
      summary:
        "Manage uploaded files with the uploads CLI (list, delete, usage), plus what to know about visibility, access, and stability.",
      aliases: ["list", "delete", "usage", "visibility"],
    },
    {
      page: "limits",
      title: "Plans & limits",
      url: "https://uploads.sh/docs/limits",
      summary:
        "Storage, file size, and member limits for uploads.sh free and pro workspaces, and how they compare with GitHub's own attachment caps.",
      aliases: ["plan", "plans", "pricing", "quota", "storage", "pro", "free"],
    },
    {
      page: "byo-bucket",
      title: "Bring your own bucket",
      url: "https://uploads.sh/docs/byo-bucket",
      summary:
        "Point a workspace at your own Cloudflare R2 or S3-compatible bucket instead of hosted storage on storage.uploads.sh.",
      aliases: ["r2", "s3", "byo", "bucket", "bring-your-own"],
    },
    {
      page: "github-screenshots",
      title: "How to get agents to upload screenshots & video to GitHub",
      url: "https://uploads.sh/github-screenshots",
      summary:
        "One command for Claude Code, CI jobs, and scripts that captures, hosts, and posts screenshots and video to PRs and issues, before or after the PR exists.",
      aliases: ["walkthrough", "agent-guide", "how-to"],
    },
    {
      page: "changelog",
      title: "Changelog",
      url: "https://uploads.sh/changelog",
      summary: "Platform updates and CLI releases, newest first.",
      aliases: ["updates", "release", "whats-new"],
    },
    {
      page: "auth",
      title: "Auth for agents",
      url: "https://uploads.sh/auth.md",
      summary: "Device sign-in, workspace bearer tokens, and hosted MCP OAuth.",
      aliases: ["login", "token", "oauth", "bearer"],
    },
  ],
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asHttpUrl(value: unknown): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return raw;
  } catch {
    return undefined;
  }
  return undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function parsePage(raw: unknown): DocsCatalogPage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as Record<string, unknown>;
  const page = asString(rec.page);
  const title = asString(rec.title);
  const url = asHttpUrl(rec.url);
  const summary = asString(rec.summary);
  if (!page || !title || !url || !summary) return undefined;
  return { page, title, url, summary, aliases: asStringArray(rec.aliases) };
}

export function parseDocsCatalog(raw: unknown): DocsCatalog {
  if (!raw || typeof raw !== "object") {
    throw new UploadsError("docs catalog was not a JSON object", "API_ERROR");
  }
  const rec = raw as Record<string, unknown>;
  if (!Array.isArray(rec.pages)) {
    throw new UploadsError("docs catalog is missing a pages array", "API_ERROR");
  }
  const pages = rec.pages.map(parsePage).filter((p): p is DocsCatalogPage => p !== undefined);
  if (pages.length === 0) {
    throw new UploadsError("docs catalog had no usable pages", "API_ERROR");
  }
  return { url: asHttpUrl(rec.url) ?? DOCS_HUB_URL, pages };
}

function clampDocsLimit(limit: number | undefined, fallback = DEFAULT_DOCS_LIMIT): number {
  const n = limit ?? fallback;
  if (n > MAX_DOCS_LIMIT) return MAX_DOCS_LIMIT;
  if (n < 1) return fallback;
  return n;
}

function tokenizeDocsQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function normalizeDocsKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https:\/\/uploads\.sh/i, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function pageKeys(page: DocsCatalogPage): string[] {
  const keys = [page.page, ...page.aliases];
  try {
    const path = new URL(page.url).pathname.replace(/^\/+/, "").replace(/\/+$/, "");
    keys.push(path);
    const leaf = path.split("/").pop();
    if (leaf) keys.push(leaf);
    if (path.startsWith("docs/")) keys.push(path.slice("docs/".length));
  } catch {
    // Catalog URLs are validated on parse; ignore a malformed fallback entry.
  }
  return keys.map(normalizeDocsKey).filter(Boolean);
}

export function resolveDocsPage(catalog: DocsCatalog, raw: string): DocsCatalogPage | undefined {
  const query = normalizeDocsKey(raw);
  if (!query) return undefined;
  const stripped = query.startsWith("docs/") ? query.slice("docs/".length) : query;
  for (const page of catalog.pages) {
    const keys = pageKeys(page);
    if (keys.includes(query) || keys.includes(stripped)) return page;
  }
  return undefined;
}

function searchableText(page: DocsCatalogPage): string {
  return `${page.page} ${page.title} ${page.summary} ${page.aliases.join(" ")}`.toLowerCase();
}

function scoreDocsPage(page: DocsCatalogPage, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const text = searchableText(page);
  let matched = 0;
  for (const token of tokens) {
    if (text.includes(token)) matched += 1;
  }
  if (matched === 0) return 0;
  return matched * 10 + (matched === tokens.length ? 40 : 0);
}

export function rankDocsPages(catalog: DocsCatalog, query: string): DocsCatalogPage[] {
  const tokens = tokenizeDocsQuery(query);
  const needle = query.trim().toLowerCase();
  const scored = catalog.pages
    .map((page) => {
      const tokenScore = tokens.length > 0 ? scoreDocsPage(page, tokens) : 0;
      const substringScore =
        tokenScore === 0 && needle.length > 0 && searchableText(page).includes(needle) ? 5 : 0;
      return { page, score: tokenScore + substringScore };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.page.title.localeCompare(b.page.title));
  return scored.map((row) => row.page);
}

export function truncateDocsSnippet(text: string, maxChars = DOCS_SNIPPET_MAX_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const cut = trimmed.slice(0, maxChars - 1);
  const atSpace = cut.lastIndexOf(" ");
  return `${atSpace > 40 ? cut.slice(0, atSpace) : cut}…`;
}

function hitFromPage(page: DocsCatalogPage, body?: string): DocsSearchHit {
  if (body === undefined) {
    return {
      title: page.title,
      url: page.url,
      page: page.page,
      snippet: page.summary,
    };
  }
  const clipped = body.length > DOCS_PAGE_MAX_CHARS ? body.slice(0, DOCS_PAGE_MAX_CHARS) : body;
  const snippet = truncateDocsSnippet(clipped);
  return {
    title: page.title,
    url: page.url,
    page: page.page,
    snippet,
    body: clipped,
    ...(snippet.length < clipped.trim().length || body.length > DOCS_PAGE_MAX_CHARS
      ? { truncated: true }
      : {}),
  };
}

function indent(text: string, prefix = "  "): string {
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? prefix.trimEnd() : `${prefix}${line}`))
    .join("\n");
}

/** Human terminal output for catalog/search hits. A fetched page prints its body. */
export function formatDocsHuman(doc: DocsSearchDocument): string {
  const lines: string[] = [];
  const only = doc.results.length === 1 ? doc.results[0] : undefined;
  if (only?.body) {
    lines.push(only.title);
    lines.push(only.url);
    lines.push("");
    lines.push(only.body.trimEnd());
    return `${lines.join("\n")}\n`;
  }
  lines.push("Docs", "");
  if (doc.results.length === 0) {
    lines.push("No matching docs.");
  } else {
    for (const hit of doc.results) {
      lines.push(hit.title);
      lines.push(hit.url);
      lines.push("");
      lines.push(indent(hit.snippet));
      lines.push("");
    }
  }
  lines.push(`See all docs: ${doc.url}`);
  return `${lines.join("\n")}\n`;
}

function isUploadsDocsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === SITE_ORIGIN;
  } catch {
    return false;
  }
}

async function fetchUrl(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { signal: controller.signal, headers });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new UploadsError(
      aborted
        ? `timed out fetching docs (${timeoutMs}ms)`
        : `couldn't reach docs (${err instanceof Error ? err.message : String(err)})`,
      "NETWORK",
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function loadDocsCatalog(opts: SearchDocsOptions = {}): Promise<DocsCatalog> {
  if (opts.catalog) return opts.catalog;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const userAgent = opts.userAgent ?? `uploads/${packageVersion()}`;
  const jsonUrl = opts.url ?? DOCS_JSON_URL;
  try {
    const res = await fetchUrl(
      fetchImpl,
      jsonUrl,
      { "user-agent": userAgent, accept: "application/json" },
      timeoutMs,
    );
    if (res.ok) {
      try {
        const payload: unknown = await res.json();
        return parseDocsCatalog(payload);
      } catch (err) {
        if (opts.url) {
          throw err instanceof UploadsError
            ? err
            : new UploadsError("docs catalog was not valid JSON", "API_ERROR", res.status);
        }
      }
    } else if (opts.url) {
      throw new UploadsError(
        `docs catalog returned HTTP ${res.status}; see ${DOCS_HUB_URL}`,
        "API_ERROR",
        res.status,
      );
    }
  } catch (err) {
    if (opts.url) throw err;
  }
  return FALLBACK_DOCS_CATALOG;
}

async function fetchPageMarkdown(
  page: DocsCatalogPage,
  opts: SearchDocsOptions,
): Promise<DocsSearchHit> {
  if (!isUploadsDocsUrl(page.url)) {
    throw new UploadsError(`refusing to fetch docs outside ${SITE_ORIGIN}`, "USAGE");
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const userAgent = opts.userAgent ?? `uploads/${packageVersion()}`;
  const res = await fetchUrl(
    fetchImpl,
    page.url,
    {
      "user-agent": userAgent,
      accept: "text/markdown, text/plain;q=0.9",
    },
    timeoutMs,
  );
  if (!res.ok) {
    throw new UploadsError(
      `docs page returned HTTP ${res.status}; see ${page.url}`,
      "API_ERROR",
      res.status,
    );
  }
  const body = await res.text();
  return hitFromPage(page, body);
}

export async function searchDocs(opts: SearchDocsOptions = {}): Promise<DocsSearchDocument> {
  const catalog = await loadDocsCatalog(opts);
  const pageArg = opts.page?.trim();
  const query = opts.query?.trim();

  if (pageArg) {
    const page = resolveDocsPage(catalog, pageArg);
    if (!page) {
      throw new UploadsError(`unknown docs page: ${pageArg}`, "USAGE");
    }
    const hit = await fetchPageMarkdown(page, opts);
    return {
      url: catalog.url,
      query: pageArg,
      results: [hit],
      total: 1,
    };
  }

  if (query) {
    const exact = resolveDocsPage(catalog, query);
    if (exact && !/\s/.test(query)) {
      const hit = await fetchPageMarkdown(exact, opts);
      return { url: catalog.url, query, results: [hit], total: 1 };
    }
    const ranked = rankDocsPages(catalog, query);
    const sliced = ranked.slice(0, clampDocsLimit(opts.limit));
    return {
      url: catalog.url,
      query,
      results: sliced.map((page) => hitFromPage(page)),
      total: ranked.length,
    };
  }

  const sliced =
    opts.limit === undefined ? catalog.pages : catalog.pages.slice(0, clampDocsLimit(opts.limit));
  return {
    url: catalog.url,
    results: sliced.map((page) => hitFromPage(page)),
    total: catalog.pages.length,
  };
}
