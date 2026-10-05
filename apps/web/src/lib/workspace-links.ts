/**
 * Row model for the Links tab (spec "Links tab"): live links (change feeds)
 * and galleries in one newest-first list. Pure, so ordering, labels, and the
 * delete-confirm copy are unit-tested; `WorkspaceLinks.tsx` renders it.
 *
 * Web copy says "live link"; the API, CLI, and D1 keep "feed".
 */
import { asPrState, type PrLabelInput } from "@uploads/ui/lib/pr-label";
import {
  GITHUB_TITLES_MAX_REFS,
  type GallerySummary,
  type GithubTitleMap,
  type OwnerFeedDto,
} from "./api-client";

export type LiveLinkScope = "pull" | "issue" | "repo";

export interface LiveLinkRow {
  type: "live";
  id: string;
  url: string;
  repo: string;
  scope: LiveLinkScope;
  number: number | null;
  path: string | null;
  /** `owner/repo#n` for PR and issue links; null for repo links. */
  ref: string | null;
  source: "comment" | "user" | null;
  updatedAt: string;
}

export interface GalleryLinkRow {
  type: "gallery";
  id: string;
  url: string;
  title: string;
  description: string | null;
  itemCount: number | null;
  previewUrl: string | null;
  references: Array<{ coordinate: string; canonicalUrl: string | null }>;
  /** Null when the API predates `version`; the row then hides Delete. */
  version: number | null;
  updatedAt: string;
}

export type LinkRow = LiveLinkRow | GalleryLinkRow;

export function liveLinkRow(feed: OwnerFeedDto): LiveLinkRow {
  const number = typeof feed.number === "number" && feed.number > 0 ? feed.number : null;
  const scope: LiveLinkScope = number === null ? "repo" : feed.kind === "issue" ? "issue" : "pull";
  const source = feed.source === "comment" || feed.source === "user" ? feed.source : null;
  return {
    type: "live",
    id: feed.id,
    url: feed.url,
    repo: feed.repo,
    scope,
    number,
    path: feed.path ?? null,
    ref: number === null ? null : `${feed.repo}#${number}`,
    source,
    updatedAt: feed.updatedAt,
  };
}

export function galleryLinkRow(gallery: GallerySummary): GalleryLinkRow {
  const description = gallery.description?.trim();
  return {
    type: "gallery",
    id: gallery.id,
    url: gallery.url,
    title: gallery.title,
    description: description ? description : null,
    itemCount: typeof gallery.itemCount === "number" ? gallery.itemCount : null,
    previewUrl: gallery.previewUrl ?? null,
    references: (gallery.references ?? []).map((ref) => ({
      coordinate: ref.coordinate,
      canonicalUrl: ref.canonicalUrl,
    })),
    version: typeof gallery.version === "number" ? gallery.version : null,
    updatedAt: gallery.updatedAt,
  };
}

export function linkRowKey(row: LinkRow): string {
  return `${row.type}:${row.id}`;
}

function timeOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** Live links and galleries in one list, most recently updated first. */
export function buildLinkRows(
  feeds: readonly OwnerFeedDto[],
  galleries: readonly GallerySummary[],
): LinkRow[] {
  const rows: LinkRow[] = [...feeds.map(liveLinkRow), ...galleries.map(galleryLinkRow)];
  return rows.sort(
    (a, b) =>
      timeOf(b.updatedAt) - timeOf(a.updatedAt) ||
      // Code-unit order, not localeCompare: the server render and the browser must agree.
      (linkRowKey(a) < linkRowKey(b) ? -1 : linkRowKey(a) > linkRowKey(b) ? 1 : 0),
  );
}

/** Distinct `owner/repo#n` refs of PR and issue live links, in row order. */
export function titleRefs(rows: readonly LinkRow[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.type === "live" && row.ref) seen.add(row.ref);
  }
  return [...seen];
}

/** Split refs into batches the titles route accepts (it caps refs per request). */
export function chunkRefs(refs: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < refs.length; i += GITHUB_TITLES_MAX_REFS) {
    out.push(refs.slice(i, i + GITHUB_TITLES_MAX_REFS));
  }
  return out;
}

/** Props for `<PrLabel>` (slice 2's `PrLabelInput`, every field set). */
export type LiveLinkLabel = Required<PrLabelInput>;

/** `<PrLabel>` input for a PR or issue link; null for a repo link. */
export function liveLinkLabel(row: LiveLinkRow, titles: GithubTitleMap): LiveLinkLabel | null {
  if (!row.ref || row.scope === "repo") return null;
  const info = titles[row.ref] ?? null;
  return {
    ghRef: row.ref,
    title: info?.title ?? null,
    state: asPrState(info?.state),
    kind: row.scope,
  };
}

/** Label for a repo-scope live link: `owner/repo`, plus its path scope when set. */
export function repoScopeLabel(row: LiveLinkRow): string {
  return row.path ? `${row.repo} · ${row.path}` : row.repo;
}

/** Source column copy (`feeds.source`). Legacy rows have none. */
export function sourceLabel(row: LiveLinkRow): string {
  if (row.source === "comment") {
    return row.scope === "issue" ? "From issue comment" : "From PR comment";
  }
  if (row.source === "user") return "Created by you";
  return "";
}

/**
 * Plain-text name for a row, for accessible names: the `owner/repo#n` ref
 * for a PR or issue link, `owner/repo` (plus any path scope) for a repo
 * link, the title for a gallery.
 */
export function linkRowName(row: LinkRow): string {
  if (row.type === "gallery") return row.title;
  return row.ref ?? repoScopeLabel(row);
}

/** Confirm copy for Delete. The PR text is the spec's, verbatim. */
export function deleteConfirmText(row: LinkRow): string {
  if (row.type === "gallery") {
    return "The gallery’s public link stops working. Its files stay in Storage.";
  }
  if (row.scope === "pull") {
    return "The old link stops working. The PR comment gets a new link on its next update.";
  }
  if (row.scope === "issue") {
    return "The old link stops working. The issue comment gets a new link on its next update.";
  }
  return "The old link stops working.";
}

export function itemsLabel(count: number | null): string {
  if (!count) return "empty";
  return count === 1 ? "1 item" : `${count} items`;
}

/** `Oct 5, 2026`. UTC so the server render and the hydrated client agree. */
export function formatLinkDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
