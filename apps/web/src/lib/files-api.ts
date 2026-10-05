/**
 * The one adapter between the Files views and the api-client scope/feed
 * functions (`ApiResult<T>` = `{ kind: "ok"; data } | { kind: "unavailable"; reason }`).
 * Views depend on `Loaded<T>` and `CreateLiveLinkResult` only, so the view
 * code never branches on api-client's result spelling.
 */
import type { FileTypeClass } from "@uploads/comment-render/scope";
import {
  createWorkspaceFeed,
  fetchPulls,
  fetchRepos,
  fetchScopeFiles,
  type ApiResult,
  type CreateFeedResult,
  type PullsResponse,
  type ReposResponse,
  type ScopeFilesResponse,
  type SessionOpts,
} from "./api-client";
import type { Loaded } from "./cursor-list";
import type { PrStateFilter } from "./files-view-state";
import type { CreateLiveLinkResult, LiveLinkScope, ScopeShareInfo } from "./live-link-flow";

export type { Loaded } from "./cursor-list";

/** SSR seeding options: the request cookie and the server transport. */
export type ServerFetchOpts = SessionOpts;

export function loaded<T>(result: ApiResult<T>): Loaded<T> {
  return result.kind === "ok"
    ? { ok: true, value: result.data }
    : { ok: false, reason: result.reason };
}

/**
 * The scope endpoint's deterministic 503 (issue #1079): the workspace has no
 * public base URL, so its files cannot be listed here and a retry won't help.
 */
export function isNotPubliclyServed(result: Loaded<unknown>): boolean {
  return !result.ok && result.reason === "not_public";
}

export async function loadPulls(
  apiOrigin: string,
  workspace: string,
  q: {
    type: FileTypeClass | null;
    repo: string;
    state: PrStateFilter | null;
    /** Lift the API's 90-day recency window ("Show older pull requests"). */
    all?: boolean;
    cursor?: string;
  },
  opts?: ServerFetchOpts,
): Promise<Loaded<PullsResponse>> {
  const result = await fetchPulls(
    apiOrigin,
    workspace,
    {
      ...(q.repo ? { repo: q.repo } : {}),
      ...(q.state ? { state: q.state } : {}),
      ...(q.type ? { type: q.type } : {}),
      ...(q.all ? { all: true } : {}),
      ...(q.cursor ? { cursor: q.cursor } : {}),
    },
    opts,
  );
  return loaded(result);
}

export async function loadRepos(
  apiOrigin: string,
  workspace: string,
  q: { type: FileTypeClass | null; cursor?: string },
  opts?: ServerFetchOpts,
): Promise<Loaded<ReposResponse>> {
  const result = await fetchRepos(
    apiOrigin,
    workspace,
    { ...(q.type ? { type: q.type } : {}), ...(q.cursor ? { cursor: q.cursor } : {}) },
    opts,
  );
  return loaded(result);
}

export async function loadScopeFiles(
  apiOrigin: string,
  workspace: string,
  q: { repo: string; number: number | null; type: FileTypeClass | null; cursor?: string },
  opts?: ServerFetchOpts,
): Promise<Loaded<ScopeFilesResponse>> {
  const result = await fetchScopeFiles(
    apiOrigin,
    workspace,
    {
      repo: q.repo,
      ...(q.number !== null ? { number: q.number } : {}),
      ...(q.type ? { type: q.type } : {}),
      ...(q.cursor ? { cursor: q.cursor } : {}),
    },
    opts,
  );
  return loaded(result);
}

export function shareInfoFromScope(
  scope: Pick<ScopeFilesResponse, "privateCount" | "liveLink">,
): ScopeShareInfo {
  return {
    privateCount: scope.privateCount,
    liveLink: scope.liveLink ? { id: scope.liveLink.id, url: scope.liveLink.url } : null,
  };
}

export async function loadShareInfo(
  apiOrigin: string,
  workspace: string,
  scope: LiveLinkScope,
): Promise<ScopeShareInfo | "not_public" | null> {
  const result = await loadScopeFiles(apiOrigin, workspace, {
    repo: scope.repo,
    number: scope.pr ?? null,
    type: null,
  });
  if (result.ok) return shareInfoFromScope(result.value);
  return isNotPubliclyServed(result) ? "not_public" : null;
}

export function normalizeCreateResult(result: CreateFeedResult): CreateLiveLinkResult {
  if (result.kind === "limit") return { kind: "limit", limit: result.limit };
  if (result.kind === "ok") return { kind: "ok", id: result.data.id, url: result.data.url };
  return result.reason === "not_public" ? { kind: "not_public" } : { kind: "error" };
}

export async function createLiveLink(
  apiOrigin: string,
  workspace: string,
  scope: LiveLinkScope,
): Promise<CreateLiveLinkResult> {
  const result = await createWorkspaceFeed(apiOrigin, workspace, {
    repo: scope.repo,
    ...(scope.pr ? { pr: scope.pr } : {}),
  });
  return normalizeCreateResult(result);
}
