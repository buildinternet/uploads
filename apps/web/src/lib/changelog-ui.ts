/**
 * Presentation helpers for /changelog: chip labels, filter keys, and the
 * token match the page script uses to hide entries. Pure — no DOM, no Astro.
 * Atom and JSON twins do not import this module.
 */

const LABELS: Record<string, string> = {
  all: "All",
  platform: "Platform",
  cli: "CLI",
  web: "Web",
  mcp: "MCP",
};

const CHIP_ORDER = ["platform", "cli", "web", "mcp"] as const;

export const CHANGELOG_FILTER_PARAM = "filter";

export type ChangelogFilterable = {
  kind: string;
  tags: readonly string[];
};

export function tagLabel(tag: string): string {
  if (LABELS[tag]) return LABELS[tag];
  return tag
    .split(/[-_]/)
    .map((part) => (part ? `${part[0].toUpperCase()}${part.slice(1)}` : part))
    .join(" ");
}

export function entryTokens(entry: ChangelogFilterable): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const token of [entry.kind, ...entry.tags]) {
    if (!token || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

export function entryChips(entry: ChangelogFilterable): string[] {
  return [...entryTokens(entry)].sort((a, b) => {
    const rankA = CHIP_ORDER.indexOf(a as (typeof CHIP_ORDER)[number]);
    const rankB = CHIP_ORDER.indexOf(b as (typeof CHIP_ORDER)[number]);
    const orderA = rankA === -1 ? CHIP_ORDER.length : rankA;
    const orderB = rankB === -1 ? CHIP_ORDER.length : rankB;
    if (orderA !== orderB) return orderA - orderB;
    return a.localeCompare(b);
  });
}

export function tokensMatchFilter(tokens: readonly string[], filter: string): boolean {
  if (!filter || filter === "all") return true;
  return tokens.includes(filter);
}

export function entryMatchesFilter(entry: ChangelogFilterable, filter: string): boolean {
  return tokensMatchFilter(entryTokens(entry), filter);
}

/**
 * Filter controls: All / Platform / CLI first, then other tags that appear
 * on any entry (Web, MCP, then the rest alphabetically).
 */
export function changelogFilterKeys(entries: readonly ChangelogFilterable[]): string[] {
  const extras = new Set<string>();
  for (const entry of entries) {
    for (const token of entryTokens(entry)) {
      if (token !== "platform" && token !== "cli") extras.add(token);
    }
  }
  const preferred = ["web", "mcp"].filter((token) => extras.has(token));
  const rest = [...extras].filter((token) => !preferred.includes(token)).sort();
  return ["all", "platform", "cli", ...preferred, ...rest];
}

export function parseChangelogFilter(
  raw: string | null | undefined,
  allowed: readonly string[],
): string {
  if (!raw || !allowed.includes(raw)) return "all";
  return raw;
}
