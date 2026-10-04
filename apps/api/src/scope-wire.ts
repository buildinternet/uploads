/**
 * Env-free wire types for the signed-in Files views (`/pulls`, `/repos`,
 * `/scope/:owner/:repo/files`), the owner feed DTOs (Links tab), the feed
 * item DTOs, and the public live-link pager. Exported as
 * `@uploads/api/scope-wire` so apps/web can `import type` them without
 * pulling a module that references the API worker's `Env` (PR #896 rule in
 * AGENTS.md). Producers: `routes/workspace-scope.ts`, `routes/feeds.ts`,
 * `feed-service.ts`.
 */
import type { FileTypeClass } from "@uploads/comment-render/scope";

/** Who created a feed row. `null` on rows created before `feeds.source`. */
export type FeedSource = "comment" | "user";

/** Real display dimensions of a video, as stamped in `video.width`/`video.height`. */
export interface VideoDimensions {
  width: number;
  height: number;
}

export interface FeedItemDto {
  id: string;
  objectKey: string;
  filename: string;
  status: "available" | "missing" | "withheld";
  url: string | null;
  embedUrl: string | null;
  /** Owner-only item page (`/c/<id>/<item>`). Absent on the public DTO. */
  pageUrl?: string;
  contentType: string | null;
  size: number | null;
  uploaded: string | null;
  modified: string | null;
  path: string | null;
  state: string | null;
  posterUrl?: string;
  videoDimensions?: VideoDimensions;
}

export interface PublicFeedItemDto {
  id: string;
  filename: string;
  status: "available" | "missing" | "withheld";
  url: string | null;
  embedUrl: string | null;
  contentType: string | null;
  size: number | null;
  uploaded?: string;
  modified?: string;
  path: string | null;
  state: string | null;
  posterUrl?: string;
  videoDimensions?: VideoDimensions;
}

/** Owner feed summary: `GET /v1/workspaces/:ws/feeds` rows and the create/get bodies minus `items`. */
export interface FeedSummaryDto {
  id: string;
  url: string;
  workspace: string;
  repo: string;
  path: string | null;
  number: number | null;
  kind: "pull" | "issue" | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** "comment" (PR comment sync), "user", or null for feeds created before this field. */
  source: FeedSource | null;
}

/** `GET /v1/workspaces/:ws/feeds`. */
export interface FeedListResponse {
  feeds: FeedSummaryDto[];
  nextCursor: string | null;
}

/** D1-only tile: no R2 HEAD, so `status` is always "available" today. */
export interface ThumbItem {
  key: string;
  kind: FileTypeClass;
  url: string | null;
  embedUrl: string | null;
  posterUrl: string | null;
  status: "available" | "missing" | "withheld";
}

export interface PullRow {
  /** "owner/repo#123", lowercased. */
  ref: string;
  repo: string;
  number: number;
  branch: string | null;
  title: string | null;
  state: "open" | "closed" | "merged" | null;
  lastMediaAt: string;
  /** Up to 4, newest first. */
  thumbnails: ThumbItem[];
}

export interface PullsResponse {
  workspace: string;
  pulls: PullRow[];
  nextCursor: string | null;
}

export interface RepoRow {
  repo: string;
  lastUpdatedAt: string;
  openPullCount: number;
  thumbnails: ThumbItem[];
}

export interface ReposResponse {
  workspace: string;
  repos: RepoRow[];
  nextCursor: string | null;
}

export interface LiveLinkRef {
  id: string;
  url: string;
  source: FeedSource | null;
}

/** PR page header data from the workspace's rollup row (Task 6). */
export interface ScopePull {
  branch: string | null;
  title: string | null;
  state: "open" | "closed" | "merged" | null;
}

export interface ScopeFilesResponse {
  repo: string;
  number: number | null;
  items: FeedItemDto[];
  nextCursor: string | null;
  /**
   * Private items across the whole scope, ignoring `type`: the items a live
   * link for this scope renders as `withheld`. First page only. `null` on
   * cursor pages, and `null` when counting would need more than 300 storage
   * probes beyond the page (unknown: skip the share confirm).
   */
  privateCount: number | null;
  /** The existing live feed for exactly this scope, if any. */
  liveLink: LiveLinkRef | null;
  /** Set when `number` is set and this workspace has a rollup row for that PR; null otherwise. */
  pull: ScopePull | null;
}

export interface PublicFeedItemPage {
  /** `kind` is the feed summary's (null for a repo-scope live link), the same value `GET /public/feeds/:id` returns. */
  feed: {
    id: string;
    title: string;
    repo: string;
    number: number | null;
    kind: "pull" | "issue" | null;
  };
  item: PublicFeedItemDto;
  /** Neighbour item ids in newest-first order. */
  prev: string | null;
  next: string | null;
  /** 0-based position in the scope. */
  index: number;
  /** Scope size, capped at 2,000. */
  total: number;
}
