/**
 * Fetch and format the public uploads.sh changelog for `uploads changelog`
 * and the MCP `changelog` tool.
 */
import { UploadsError } from "./errors.js";
import { packageVersion } from "./package-version.js";

export const CHANGELOG_PAGE_URL = "https://uploads.sh/changelog";
export const CHANGELOG_JSON_URL = "https://uploads.sh/changelog.json";
export const CHANGELOG_XML_URL = "https://uploads.sh/changelog.xml";
export const DEFAULT_CHANGELOG_LIMIT = 5;
export const MAX_CHANGELOG_LIMIT = 50;

const FETCH_TIMEOUT_MS = 8000;

export type ChangelogKind = "platform" | "cli";

export type ChangelogJsonEntry = {
  id: string;
  kind: ChangelogKind;
  title: string;
  date: string;
  url: string;
  tags: string[];
  summary: string;
  body: string;
};

export type ChangelogDocument = {
  url: string;
  feed?: string;
  entries: ChangelogJsonEntry[];
};

export type FetchChangelogOptions = {
  limit?: number;
  url?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
};

function isKind(value: unknown): value is ChangelogKind {
  return value === "platform" || value === "cli";
}

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

function parseEntry(raw: unknown): ChangelogJsonEntry | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as Record<string, unknown>;
  const id = asString(rec.id);
  const title = asString(rec.title);
  const date = asString(rec.date);
  const url = asHttpUrl(rec.url);
  const summary = asString(rec.summary);
  if (!id || !title || !date || !url || !summary) return undefined;
  const kind: ChangelogKind = isKind(rec.kind) ? rec.kind : "platform";
  const tags = Array.isArray(rec.tags)
    ? rec.tags.filter((t): t is string => typeof t === "string" && t.length > 0)
    : [];
  return {
    id,
    kind,
    title,
    date,
    url,
    tags,
    summary,
    body: typeof rec.body === "string" ? rec.body : "",
  };
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tagMatch(block: string, tag: string): string | undefined {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m?.[1] === undefined ? undefined : decodeXml(m[1]).trim();
}

function attrMatch(block: string, tag: string, attr: string): string | undefined {
  const m = block.match(new RegExp(`<${tag}[^>]*\\s${attr}="([^"]+)"`));
  return m?.[1] === undefined ? undefined : decodeXml(m[1]).trim();
}

function truncateSummary(text: string, maxChars = 280): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars - 1);
  const atSpace = cut.lastIndexOf(" ");
  return `${atSpace > 40 ? cut.slice(0, atSpace) : cut}…`;
}

/** Parse the Atom twin at /changelog.xml (fallback when JSON is not deployed yet). */
export function parseChangelogAtom(xml: string): ChangelogDocument {
  const entries: ChangelogJsonEntry[] = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;
  while ((match = entryRe.exec(xml))) {
    const block = match[1] ?? "";
    const title = tagMatch(block, "title");
    const date = tagMatch(block, "updated");
    const url = attrMatch(block, "link", "href") ?? tagMatch(block, "id");
    const idHref = tagMatch(block, "id") ?? url ?? "";
    const hash = idHref.indexOf("#");
    const id = hash >= 0 ? idHref.slice(hash + 1) : undefined;
    const tags = [...block.matchAll(/<category\s+term="([^"]+)"/g)].map((m) =>
      decodeXml(m[1] ?? ""),
    );
    const html = tagMatch(block, "content") ?? "";
    const plain = stripHtml(html);
    if (!title || !date || !url || !id || !plain) continue;
    const kind: ChangelogKind =
      tags.includes("cli") && !tags.includes("platform") ? "cli" : "platform";
    entries.push({
      id,
      kind,
      title,
      date,
      url,
      tags,
      summary: truncateSummary(plain),
      body: plain,
    });
  }
  if (entries.length === 0) {
    throw new UploadsError("changelog Atom feed had no usable entries", "API_ERROR");
  }
  return { url: CHANGELOG_PAGE_URL, feed: CHANGELOG_XML_URL, entries };
}

export function parseChangelogJson(raw: unknown): ChangelogDocument {
  if (!raw || typeof raw !== "object") {
    throw new UploadsError("changelog response was not a JSON object", "API_ERROR");
  }
  const rec = raw as Record<string, unknown>;
  if (!Array.isArray(rec.entries)) {
    throw new UploadsError("changelog response is missing an entries array", "API_ERROR");
  }
  const entries = rec.entries
    .map(parseEntry)
    .filter((e): e is ChangelogJsonEntry => e !== undefined);
  if (rec.entries.length > 0 && entries.length === 0) {
    throw new UploadsError("changelog response had no usable entries", "API_ERROR");
  }
  const feed = asHttpUrl(rec.feed);
  return {
    url: asHttpUrl(rec.url) ?? CHANGELOG_PAGE_URL,
    ...(feed ? { feed } : {}),
    entries,
  };
}

export function clampChangelogLimit(limit: number | undefined): number {
  const n = limit ?? DEFAULT_CHANGELOG_LIMIT;
  if (n > MAX_CHANGELOG_LIMIT) return MAX_CHANGELOG_LIMIT;
  if (n < 1) return DEFAULT_CHANGELOG_LIMIT;
  return n;
}

export function selectChangelogEntries(doc: ChangelogDocument, limit?: number): ChangelogDocument {
  const n = clampChangelogLimit(limit);
  return { ...doc, entries: doc.entries.slice(0, n) };
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function indent(text: string, prefix = "  "): string {
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? prefix.trimEnd() : `${prefix}${line}`))
    .join("\n");
}

/** Human terminal output: recent titles + summaries, then a link to the page. */
export function formatChangelogHuman(doc: ChangelogDocument): string {
  const lines: string[] = ["What's new", ""];
  if (doc.entries.length === 0) {
    lines.push("No changelog entries.");
  } else {
    for (const entry of doc.entries) {
      lines.push(entry.title);
      lines.push(`${formatDate(entry.date)}  ·  ${entry.url}`);
      lines.push("");
      lines.push(indent(entry.summary));
      lines.push("");
    }
  }
  lines.push(`See all updates: ${doc.url}`);
  return `${lines.join("\n")}\n`;
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
        ? `timed out fetching changelog (${timeoutMs}ms)`
        : `couldn't reach changelog (${err instanceof Error ? err.message : String(err)})`,
      "NETWORK",
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchChangelog(opts: FetchChangelogOptions = {}): Promise<ChangelogDocument> {
  const explicitUrl = opts.url;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const userAgent = opts.userAgent ?? `uploads/${packageVersion()}`;
  const headers = { "user-agent": userAgent };

  const jsonUrl = explicitUrl ?? CHANGELOG_JSON_URL;
  const jsonRes = await fetchUrl(
    fetchImpl,
    jsonUrl,
    { ...headers, accept: "application/json" },
    timeoutMs,
  );
  if (jsonRes.ok) {
    try {
      const payload: unknown = await jsonRes.json();
      return selectChangelogEntries(parseChangelogJson(payload), opts.limit);
    } catch (err) {
      if (explicitUrl) {
        throw err instanceof UploadsError
          ? err
          : new UploadsError("changelog response was not valid JSON", "API_ERROR", jsonRes.status);
      }
    }
  } else if (explicitUrl) {
    throw new UploadsError(
      `changelog returned HTTP ${jsonRes.status}; see ${CHANGELOG_PAGE_URL}`,
      "API_ERROR",
      jsonRes.status,
    );
  }

  // JSON twin is new; fall back to the Atom feed that already ships.
  const xmlRes = await fetchUrl(
    fetchImpl,
    CHANGELOG_XML_URL,
    { ...headers, accept: "application/atom+xml, application/xml, text/xml" },
    timeoutMs,
  );
  if (!xmlRes.ok) {
    throw new UploadsError(
      `changelog returned HTTP ${xmlRes.status}; see ${CHANGELOG_PAGE_URL}`,
      "API_ERROR",
      xmlRes.status,
    );
  }
  const xml = await xmlRes.text();
  return selectChangelogEntries(parseChangelogAtom(xml), opts.limit);
}
