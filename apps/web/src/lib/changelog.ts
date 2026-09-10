/**
 * Build-time data source for /changelog and /changelog.xml.
 *
 * Merges two streams into one newest-first list:
 *  - platform updates: the `changelog` content collection (hand-written .md)
 *  - CLI releases: `packages/uploads/CHANGELOG.md` (changesets output),
 *    dated via the npm registry's `time` map, since changesets carry no dates.
 *
 * Everything here runs at build time only. Failures throw so a bad build
 * never ships an incomplete changelog.
 */
import { marked } from "marked";

export type ChangelogImage = { url: string; alt: string };

export type ChangelogEntry = {
  kind: "platform" | "cli";
  /** Stable anchor id, e.g. "screenshots-page" or "cli-0-41-1". */
  id: string;
  title: string;
  /** ISO 8601 UTC timestamp. */
  date: string;
  /** Rendered HTML body. */
  html: string;
  /** Source markdown, for the JSON twin and CLI. */
  markdown: string;
  tags: string[];
  image?: ChangelogImage;
};

const NPM_PACKAGE_URL = "https://registry.npmjs.org/@buildinternet/uploads";

export function parseCliChangelog(md: string): { version: string; body: string }[] {
  const sections: { version: string; body: string }[] = [];
  const matches = [...md.matchAll(/^## (\d+\.\d+\.\d+(?:-[\w.]+)?)\s*$/gm)];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const start = (match.index ?? 0) + match[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : md.length;
    sections.push({ version: match[1], body: md.slice(start, end).trim() });
  }
  if (sections.length === 0) {
    throw new Error("parseCliChangelog: no version sections found in CHANGELOG.md");
  }
  return sections;
}

export function cliAnchorId(version: string): string {
  return `cli-${version.replaceAll(".", "-")}`;
}

export async function fetchCliReleaseDates(
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, string>> {
  const res = await fetchImpl(NPM_PACKAGE_URL, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`npm registry responded ${res.status} for @buildinternet/uploads`);
  }
  const data = (await res.json()) as { time?: Record<string, string> };
  if (!data.time) {
    throw new Error("npm registry response has no time map");
  }
  const { created: _created, modified: _modified, ...versions } = data.time;
  return versions;
}

export function renderMarkdown(md: string): string {
  return marked.parse(md, { async: false }) as string;
}

const CHANGESET_SHA_PREFIX = /^[0-9a-f]{7,40}:\s*/i;

/**
 * First paragraph of an entry as plain text, for CLI/JSON summaries.
 * Strips headings, images, and link markup; truncates at a word boundary.
 */
export function entrySummary(markdown: string, maxChars = 280): string {
  const withoutChrome = markdown
    .replace(/^#{1,6}\s+.*$/gm, "")
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .trim();
  const firstBlock = withoutChrome.split(/\n\s*\n/)[0] ?? "";
  const text = firstBlock
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(CHANGESET_SHA_PREFIX, "");
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars - 1);
  const atSpace = cut.lastIndexOf(" ");
  return `${atSpace > 40 ? cut.slice(0, atSpace) : cut}…`;
}

export function mergeEntries(entries: ChangelogEntry[]): ChangelogEntry[] {
  return [...entries].sort((a, b) => {
    const byDate = Date.parse(b.date) - Date.parse(a.date);
    if (byDate !== 0) return byDate;
    if (a.kind === b.kind) return 0;
    return a.kind === "platform" ? -1 : 1;
  });
}

let cached: Promise<ChangelogEntry[]> | null = null;

/**
 * /changelog, /changelog.xml, and /changelog.json call this during the same
 * build; cache the promise so the npm registry fetch (and content-collection
 * load) only happens once per build instead of once per route. A rejected
 * build-time promise still rejects every caller, so failures still fail the
 * build.
 */
export function loadChangelogEntries(): Promise<ChangelogEntry[]> {
  cached ??= buildChangelogEntries();
  return cached;
}

async function buildChangelogEntries(): Promise<ChangelogEntry[]> {
  const [{ cliChangelogRaw }, { getChangelogCollection }] = await Promise.all([
    import("./changelog-source"),
    import("./changelog-collection"),
  ]);
  const [posts, dates] = await Promise.all([getChangelogCollection(), fetchCliReleaseDates()]);

  const platform: ChangelogEntry[] = posts.map((post) => ({
    kind: "platform",
    id: post.id,
    title: post.data.title,
    date: post.data.date.toISOString(),
    html: renderMarkdown(post.body ?? ""),
    markdown: post.body ?? "",
    tags: post.data.tags,
    image: post.data.image,
  }));

  const cli: ChangelogEntry[] = parseCliChangelog(cliChangelogRaw)
    // Versions missing from npm (e.g. the skipped 0.20.0) are dropped.
    .filter((section) => dates[section.version] !== undefined)
    .map((section) => ({
      kind: "cli" as const,
      id: cliAnchorId(section.version),
      title: `CLI ${section.version}`,
      date: dates[section.version],
      html: renderMarkdown(section.body),
      markdown: section.body,
      tags: ["cli"],
    }));

  return mergeEntries([...platform, ...cli]);
}
