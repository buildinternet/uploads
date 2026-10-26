/**
 * Field-by-field parsers for the slice 1 scope endpoints (`/pulls`,
 * `/repos`, `/scope/:owner/:repo/files`) and the owner feed DTO. The types
 * come from the producer (`@uploads/api/scope-wire`, Env-free, AGENTS.md
 * "Wire types"); this module only checks the JSON at runtime. A parser
 * returns null for any wrong-typed field, so a drifted API fails as
 * "malformed" rather than rendering garbage. Three fields stay lenient for
 * an API older than slice 1: a missing `source` reads as null, a missing
 * `pull` reads as null, and an unknown PR `state` reads as null.
 */
import type { FileTypeClass } from "@uploads/comment-render/scope";
import type {
  FeedItemDto,
  FeedListResponse,
  FeedSource,
  FeedSummaryDto,
  LiveLinkRef,
  PullRow,
  PullsResponse,
  RepoRow,
  ReposResponse,
  ScopeFilesResponse,
  ScopePull,
  ThumbItem,
} from "@uploads/api/scope-wire";
import { asPrState } from "@uploads/ui/lib/pr-label";

type Rec = Record<string, unknown>;
type ItemStatus = FeedItemDto["status"];

export function isRecord(value: unknown): value is Rec {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isNullableStr = (v: unknown): v is string | null => v === null || typeof v === "string";
const isPositiveInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isStatus = (v: unknown): v is ItemStatus =>
  v === "available" || v === "missing" || v === "withheld";
const isFileTypeClass = (v: unknown): v is FileTypeClass =>
  v === "screenshot" || v === "video" || v === "other";

function parseSource(v: unknown): FeedSource | null {
  return v === "comment" || v === "user" ? v : null;
}

function parseList<T>(value: unknown, parse: (entry: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const out: T[] = [];
  for (const entry of value) {
    const parsed = parse(entry);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

function parseThumbItem(v: unknown): ThumbItem | null {
  if (!isRecord(v) || !isStr(v.key) || !isFileTypeClass(v.kind) || !isStatus(v.status)) return null;
  const posterUrl = v.posterUrl ?? null;
  if (!isNullableStr(v.url) || !isNullableStr(v.embedUrl) || !isNullableStr(posterUrl)) return null;
  return {
    key: v.key,
    kind: v.kind,
    url: v.url,
    embedUrl: v.embedUrl,
    posterUrl,
    status: v.status,
  };
}

function parsePullRow(v: unknown): PullRow | null {
  if (!isRecord(v) || !isStr(v.ref) || !isStr(v.repo) || !isPositiveInt(v.number)) return null;
  const branch = v.branch ?? null;
  const title = v.title ?? null;
  if (!isNullableStr(branch) || !isNullableStr(title) || !isStr(v.lastMediaAt)) return null;
  const thumbnails = parseList(v.thumbnails, parseThumbItem);
  if (!thumbnails) return null;
  return {
    ref: v.ref,
    repo: v.repo,
    number: v.number,
    branch,
    title,
    state: asPrState(v.state),
    lastMediaAt: v.lastMediaAt,
    thumbnails,
  };
}

export function parsePullsResponse(v: unknown): PullsResponse | null {
  if (!isRecord(v) || !isStr(v.workspace)) return null;
  const nextCursor = v.nextCursor ?? null;
  if (!isNullableStr(nextCursor)) return null;
  const pulls = parseList(v.pulls, parsePullRow);
  return pulls ? { workspace: v.workspace, pulls, nextCursor } : null;
}

function parseRepoRow(v: unknown): RepoRow | null {
  if (!isRecord(v) || !isStr(v.repo) || !isStr(v.lastUpdatedAt) || !isCount(v.openPullCount)) {
    return null;
  }
  const thumbnails = parseList(v.thumbnails, parseThumbItem);
  if (!thumbnails) return null;
  return {
    repo: v.repo,
    lastUpdatedAt: v.lastUpdatedAt,
    openPullCount: v.openPullCount,
    thumbnails,
  };
}

export function parseReposResponse(v: unknown): ReposResponse | null {
  if (!isRecord(v) || !isStr(v.workspace)) return null;
  const nextCursor = v.nextCursor ?? null;
  if (!isNullableStr(nextCursor)) return null;
  const repos = parseList(v.repos, parseRepoRow);
  return repos ? { workspace: v.workspace, repos, nextCursor } : null;
}

function parseFeedItem(v: unknown): FeedItemDto | null {
  if (!isRecord(v) || !isStr(v.id) || !isStr(v.objectKey) || !isStr(v.filename)) return null;
  if (!isStatus(v.status) || !isNullableStr(v.url) || !isNullableStr(v.embedUrl)) return null;
  if (!isNullableStr(v.contentType) || !(v.size === null || isCount(v.size))) return null;
  if (!isNullableStr(v.uploaded) || !isNullableStr(v.modified)) return null;
  if (!isNullableStr(v.path) || !isNullableStr(v.state)) return null;
  if (v.pageUrl !== undefined && !isStr(v.pageUrl)) return null;
  if (v.posterUrl !== undefined && !isStr(v.posterUrl)) return null;
  const item: FeedItemDto = {
    id: v.id,
    objectKey: v.objectKey,
    filename: v.filename,
    status: v.status,
    url: v.url,
    embedUrl: v.embedUrl,
    contentType: v.contentType,
    size: v.size,
    uploaded: v.uploaded,
    modified: v.modified,
    path: v.path,
    state: v.state,
  };
  if (v.pageUrl !== undefined) item.pageUrl = v.pageUrl;
  if (v.posterUrl !== undefined) item.posterUrl = v.posterUrl;
  const dims = v.videoDimensions;
  if (dims !== undefined) {
    if (!isRecord(dims) || !isPositiveInt(dims.width) || !isPositiveInt(dims.height)) return null;
    item.videoDimensions = { width: dims.width, height: dims.height };
  }
  return item;
}

function parseLiveLink(v: unknown): LiveLinkRef | null | undefined {
  if (v === null || v === undefined) return null;
  if (!isRecord(v) || !isStr(v.id) || !isStr(v.url)) return undefined;
  return { id: v.id, url: v.url, source: parseSource(v.source) };
}

function parseScopePull(v: unknown): ScopePull | null | undefined {
  if (v === null || v === undefined) return null;
  if (!isRecord(v)) return undefined;
  const branch = v.branch ?? null;
  const title = v.title ?? null;
  if (!isNullableStr(branch) || !isNullableStr(title)) return undefined;
  return { branch, title, state: asPrState(v.state) };
}

export function parseScopeFilesResponse(v: unknown): ScopeFilesResponse | null {
  if (!isRecord(v) || !isStr(v.repo) || !(v.number === null || isPositiveInt(v.number)))
    return null;
  const nextCursor = v.nextCursor ?? null;
  const privateCount = v.privateCount ?? null;
  if (!isNullableStr(nextCursor) || !(privateCount === null || isCount(privateCount))) return null;
  const items = parseList(v.items, parseFeedItem);
  const liveLink = parseLiveLink(v.liveLink);
  const pull = parseScopePull(v.pull);
  if (!items || liveLink === undefined || pull === undefined) return null;
  return { repo: v.repo, number: v.number, items, nextCursor, privateCount, liveLink, pull };
}

export function parseOwnerFeed(v: unknown): FeedSummaryDto | null {
  if (!isRecord(v)) return null;
  const { id, url, workspace, repo, path, number, kind, title, createdAt, updatedAt } = v;
  if (!isStr(id) || !isStr(url) || !isStr(workspace) || !isStr(repo) || !isStr(title)) return null;
  if (!isStr(createdAt) || !isStr(updatedAt) || !isNullableStr(path)) return null;
  if (!(number === null || isPositiveInt(number))) return null;
  if (!(kind === null || kind === "pull" || kind === "issue")) return null;
  return {
    id,
    url,
    workspace,
    repo,
    path,
    number,
    kind,
    title,
    createdAt,
    updatedAt,
    source: parseSource(v.source),
  };
}

export function parseFeedListPage(v: unknown): FeedListResponse | null {
  if (!isRecord(v)) return null;
  const nextCursor = v.nextCursor ?? null;
  if (!isNullableStr(nextCursor)) return null;
  const feeds = parseList(v.feeds, parseOwnerFeed);
  return feeds ? { feeds, nextCursor } : null;
}
