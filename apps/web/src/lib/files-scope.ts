/**
 * Pure helpers for the Files list rows and the PR/repo pages: DTO → tile
 * mapping, before/after ordering, `path` grouping, and empty-state copy.
 */
import type { FileTypeClass } from "@uploads/comment-render/scope";
import type { ScopeFilesResponse, ThumbItem } from "./api-client";
import { typeEmptyNoun } from "./files-view-state";
import { pairPartners } from "./workspace-screenshots";

export type ScopeItemDto = ScopeFilesResponse["items"][number];

export interface ScopeTile {
  key: string;
  url: string | null;
  embedUrl: string | null;
  status: string;
  contentType: string | null;
  posterUrl: string | null;
  state?: string;
  path: string | null;
  updatedAt?: string;
}

/** Owner scope DTO → tile. `pageUrl` (the `/c/` item page) is dropped on purpose: tiles open through file-opener. */
export function scopeItemToTile(item: ScopeItemDto): ScopeTile {
  const updatedAt = item.modified ?? item.uploaded ?? undefined;
  return {
    key: item.objectKey,
    url: item.url,
    embedUrl: item.embedUrl,
    status: item.status,
    contentType: item.contentType,
    posterUrl: item.posterUrl ?? null,
    ...(item.state ? { state: item.state } : {}),
    path: item.path,
    ...(updatedAt ? { updatedAt } : {}),
  };
}

export function thumbToTile(thumb: ThumbItem): ScopeTile {
  return {
    key: thumb.key,
    url: thumb.url,
    embedUrl: thumb.embedUrl,
    status: thumb.status,
    contentType: null,
    posterUrl: thumb.posterUrl,
    path: null,
  };
}

/** Newest-first order, except a before/after pair renders side by side (before first). */
export function keepPairsTogether<T extends { key: string; state?: string }>(items: T[]): T[] {
  const partners = pairPartners(items);
  const byKey = new Map(items.map((item) => [item.key, item]));
  const placed = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (placed.has(item.key)) continue;
    const partnerKey = partners.get(item.key);
    const partner = partnerKey ? byKey.get(partnerKey) : undefined;
    if (partner && !placed.has(partner.key)) {
      const [first, second] = item.state === "after" ? [partner, item] : [item, partner];
      out.push(first, second);
      placed.add(first.key);
      placed.add(second.key);
    } else {
      out.push(item);
      placed.add(item.key);
    }
  }
  return out;
}

/** Same rule as comment-render's pairAttachments: trimmed, and ""/whitespace/bare "/" mean no path. */
function usablePath(path: string | null): string | null {
  const trimmed = path?.trim();
  return !trimmed || trimmed === "/" ? null : trimmed;
}

export function groupScopeItemsByPath<
  T extends { key: string; state?: string; path: string | null },
>(items: T[]): Array<{ path: string | null; items: T[] }> {
  const groups = new Map<string | null, T[]>();
  for (const item of items) {
    const path = usablePath(item.path);
    const bucket = groups.get(path);
    if (bucket) bucket.push(item);
    else groups.set(path, [item]);
  }
  return [...groups.entries()].map(([path, grouped]) => ({
    path,
    items: keepPairsTogether(grouped),
  }));
}

export function appendPage<T>(prev: T[], next: T[], keyOf: (row: T) => string): T[] {
  const seen = new Set(prev.map(keyOf));
  return [...prev, ...next.filter((row) => !seen.has(keyOf(row)))];
}

export function openPullsLabel(count: number): string {
  if (count === 0) return "no open PRs";
  return count === 1 ? "1 open PR" : `${count} open PRs`;
}

export function scopeEmptyCopy(input: { number: number | null; type: FileTypeClass | null }): {
  title: string;
  description: string;
  command: string | null;
} {
  const where = input.number !== null ? "on this pull request" : "in this repo";
  if (input.type !== null) {
    return {
      title: `No ${typeEmptyNoun(input.type)} ${where}`,
      description: "Clear the type filter to see every file.",
      command: null,
    };
  }
  if (input.number !== null) {
    return {
      title: "No files on this pull request",
      description:
        "Files attached with --pr show up here, newest first. Files removed from the pull request drop off.",
      command: `uploads put ./shot.png --pr ${input.number}`,
    };
  }
  return {
    title: "No files in this repo",
    description: "Files attached to this repo's pull requests show up here, newest first.",
    command: "uploads put ./shot.png --pr 123",
  };
}
