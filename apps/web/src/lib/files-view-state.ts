/**
 * URL and route state for the Files tab (spec: .context/2026-10-04-pr-first-
 * workspace-and-live-links.md, "Routes" and "Files views"). Pure: no DOM, no
 * fetch, so vitest covers it. Top-level views use `?view=` so a GitHub owner
 * named `repos` or `pages` cannot collide with a route.
 */
import {
  FILE_SURFACES,
  fileTypeClassFromKey,
  type FileSurface,
  type FileTypeClass,
} from "@uploads/comment-render/scope";

export type FilesView = "pulls" | "repos" | "pages";
export type PrStateFilter = "open" | "closed" | "merged";
/** Upload-time window (`?since=`), relative so a shared link keeps its meaning. */
export type SinceFilter = "1d" | "7d" | "30d";

export interface FilesQuery {
  view: FilesView;
  type: FileTypeClass | null;
  /** Device (`?surface=`), from the classifier's `ai.surface` label. */
  surface: FileSurface | null;
  since: SinceFilter | null;
  /** Lowercased `owner/repo`, "" for all repos. By pull request only. */
  repo: string;
  /** By pull request only. */
  state: PrStateFilter | null;
  /**
   * By pull request only: "Show older pull requests" lifted the 90-day
   * window (`?all=1`). In the URL so Back from a PR page keeps the older rows.
   */
  all: boolean;
}

export interface ScopePageQuery {
  type: FileTypeClass | null;
  surface: FileSurface | null;
  since: SinceFilter | null;
  /** PR page: group tiles by `path` metadata (`?group=path`). */
  groupByPath: boolean;
}

export const FILE_TYPE_LABELS: Record<FileTypeClass, string> = {
  screenshot: "Screenshots",
  video: "Videos",
  other: "Other",
};

export const FILE_SURFACE_LABELS: Record<FileSurface, string> = {
  mobile: "Mobile",
  desktop: "Desktop",
  tablet: "Tablet",
};

export const SINCE_FILTERS: readonly SinceFilter[] = ["1d", "7d", "30d"];

export const SINCE_LABELS: Record<SinceFilter, string> = {
  "1d": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

const FILE_TYPES: readonly string[] = ["screenshot", "video", "other"];
const PR_STATES: readonly string[] = ["open", "closed", "merged"];
/** One owner or repo segment after lowercasing. Rejects "." and "..". */
const NAME_SEGMENT_RE = /^(?!\.{1,2}$)[a-z0-9._-]{1,100}$/;

function searchParams(search: string): URLSearchParams {
  return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
}

export function parseFileTypeParam(raw: string | null | undefined): FileTypeClass | null {
  return raw && FILE_TYPES.includes(raw) ? (raw as FileTypeClass) : null;
}

export function parseSurfaceParam(raw: string | null | undefined): FileSurface | null {
  return raw && (FILE_SURFACES as readonly string[]).includes(raw) ? (raw as FileSurface) : null;
}

export function parseSinceParam(raw: string | null | undefined): SinceFilter | null {
  return raw && (SINCE_FILTERS as readonly string[]).includes(raw) ? (raw as SinceFilter) : null;
}

/** Client-side twin of the API's `since`, for items fetched without it. */
export function matchesSinceFilter(
  updatedAt: string | undefined,
  since: SinceFilter | null,
  now: number = Date.now(),
): boolean {
  if (since === null) return true;
  if (!updatedAt) return false;
  return Date.parse(updatedAt) >= now - Number.parseInt(since, 10) * 86_400_000;
}

export function parsePrStateParam(raw: string | null | undefined): PrStateFilter | null {
  return raw && PR_STATES.includes(raw) ? (raw as PrStateFilter) : null;
}

export function readFilesView(search: string): FilesView {
  const view = searchParams(search).get("view");
  return view === "repos" || view === "pages" ? view : "pulls";
}

export function normalizeRepoParam(owner: string, repo: string): string | null {
  const o = owner.trim().toLowerCase();
  const r = repo.trim().toLowerCase();
  if (!NAME_SEGMENT_RE.test(o) || !NAME_SEGMENT_RE.test(r)) return null;
  return `${o}/${r}`;
}

export function normalizeRepoFilter(raw: string | null | undefined): string {
  if (!raw) return "";
  const slash = raw.indexOf("/");
  if (slash <= 0) return "";
  return normalizeRepoParam(raw.slice(0, slash), raw.slice(slash + 1)) ?? "";
}

export function readFilesQuery(search: string): FilesQuery {
  const params = searchParams(search);
  const view = readFilesView(search);
  return {
    view,
    type: parseFileTypeParam(params.get("type")),
    surface: parseSurfaceParam(params.get("surface")),
    since: parseSinceParam(params.get("since")),
    repo: view === "pulls" ? normalizeRepoFilter(params.get("repo")) : "",
    state: view === "pulls" ? parsePrStateParam(params.get("state")) : null,
    all: view === "pulls" && params.get("all") === "1",
  };
}

export function filesSearch(query: FilesQuery): string {
  const params = new URLSearchParams();
  if (query.view !== "pulls") params.set("view", query.view);
  if (query.type) params.set("type", query.type);
  if (query.surface) params.set("surface", query.surface);
  if (query.since) params.set("since", query.since);
  if (query.view === "pulls" && query.repo) params.set("repo", query.repo);
  if (query.view === "pulls" && query.state) params.set("state", query.state);
  if (query.view === "pulls" && query.all) params.set("all", "1");
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function readScopePageQuery(search: string): ScopePageQuery {
  const params = searchParams(search);
  return {
    type: parseFileTypeParam(params.get("type")),
    surface: parseSurfaceParam(params.get("surface")),
    since: parseSinceParam(params.get("since")),
    groupByPath: params.get("group") === "path",
  };
}

export function scopePageSearch(query: ScopePageQuery): string {
  const params = new URLSearchParams();
  if (query.type) params.set("type", query.type);
  if (query.surface) params.set("surface", query.surface);
  if (query.since) params.set("since", query.since);
  if (query.groupByPath) params.set("group", "path");
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function filesBasePath(workspace: string): string {
  return `/account/workspaces/${encodeURIComponent(workspace)}/files`;
}

export function filesViewHref(workspace: string, view: FilesView): string {
  return `${filesBasePath(workspace)}${filesSearch({ view, type: null, surface: null, since: null, repo: "", state: null, all: false })}`;
}

function splitRepo(repo: string): [string, string] | null {
  const normalized = normalizeRepoFilter(repo);
  if (!normalized) return null;
  const slash = normalized.indexOf("/");
  return [normalized.slice(0, slash), normalized.slice(slash + 1)];
}

export function filesRepoHref(workspace: string, repo: string): string {
  const parts = splitRepo(repo);
  if (!parts) return filesViewHref(workspace, "repos");
  return `${filesBasePath(workspace)}/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`;
}

export function filesPrHref(workspace: string, repo: string, number: number): string {
  if (!splitRepo(repo) || !Number.isInteger(number) || number <= 0) {
    return filesViewHref(workspace, "pulls");
  }
  return `${filesRepoHref(workspace, repo)}/pull/${number}`;
}

export function linksHref(workspace: string): string {
  return `/account/workspaces/${encodeURIComponent(workspace)}/links`;
}

export function parsePrNumberParam(raw: string | null | undefined): number | null {
  if (!raw || !/^\d{1,9}$/.test(raw)) return null;
  const number = Number(raw);
  return number > 0 ? number : null;
}

/** Files PR page for a right-rail / banner work item; null for issues or bad refs. */
export function filesPrHrefForWorkItem(
  workspace: string,
  item: { kind: string; repo: string; number: string },
): string | null {
  if (item.kind !== "pull") return null;
  const number = parsePrNumberParam(item.number);
  if (number === null || !splitRepo(item.repo)) return null;
  return filesPrHref(workspace, item.repo, number);
}

/**
 * Canonical repo/PR page for raw route params. Pages compare `path` to the
 * request path and 301 when they differ, so `Foo.Bar/My-Repo/pull/007` and
 * `foo.bar/my-repo/pull/7` share one URL and one live-link scope.
 */
export function canonicalScopePath(
  workspace: string,
  params: { owner?: string; repo?: string; number?: string },
): { repo: string; number: number | null; path: string } | null {
  const repo = normalizeRepoParam(params.owner ?? "", params.repo ?? "");
  if (!repo) return null;
  if (params.number === undefined) {
    return { repo, number: null, path: filesRepoHref(workspace, repo) };
  }
  const number = parsePrNumberParam(params.number);
  if (number === null) return null;
  return { repo, number, path: filesPrHref(workspace, repo, number) };
}

export function matchesTypeFilter(key: string, type: FileTypeClass | null): boolean {
  return type === null || fileTypeClassFromKey(key) === type;
}

/** Client-side twin of the API's `surface` filter, for items that carry metadata. */
export function matchesSurfaceFilter(
  metadata: Record<string, string> | undefined,
  surface: FileSurface | null,
): boolean {
  return surface === null || metadata?.["ai.surface"] === surface;
}

export function prStateFromTitle(state: string | null | undefined): PrStateFilter | null {
  return parsePrStateParam(state ?? null);
}

export function typeEmptyNoun(
  type: FileTypeClass | null,
  surface: FileSurface | null = null,
): string {
  const noun =
    type === "screenshot"
      ? "screenshots"
      : type === "video"
        ? "videos"
        : type === "other"
          ? "other files"
          : "files";
  return surface ? `${FILE_SURFACE_LABELS[surface].toLowerCase()} ${noun}` : noun;
}

/** " in the last 7 days" for empty-state titles; "" without a window. */
export function sinceEmptySuffix(since: SinceFilter | null): string {
  return since ? ` in the ${SINCE_LABELS[since].toLowerCase()}` : "";
}

export type PullsEmptyCopy =
  | { kind: "filtered"; title: string }
  | { kind: "command"; title: string; description: string };

/**
 * By pull request empty state. `/pulls` only covers the last 90 days unless
 * `all=1` ("Show older pull requests"), and it never says whether older rows
 * exist, so the copy names the window until the viewer has looked past it.
 */
export function pullsEmptyCopy(input: {
  filtering: boolean;
  showOlder: boolean;
  /** An explicit window replaces the 90-day default. */
  since?: SinceFilter | null;
}): PullsEmptyCopy {
  if (input.since) {
    return {
      kind: "filtered",
      title: `No pull requests${sinceEmptySuffix(input.since)}${input.filtering ? " match these filters" : ""}.`,
    };
  }
  if (input.filtering) {
    return {
      kind: "filtered",
      title: input.showOlder
        ? "No pull requests match these filters."
        : "No pull requests in the last 90 days match these filters.",
    };
  }
  return input.showOlder
    ? {
        kind: "command",
        title: "No pull request files yet",
        description: "Files attached to a pull request show up here, newest first.",
      }
    : {
        kind: "command",
        title: "No pull request files in the last 90 days",
        description:
          "Files attached to a pull request show up here, newest first. Older pull requests are below.",
      };
}
