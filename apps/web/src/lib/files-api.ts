/**
 * The one adapter between the Files views and slice 2's api-client
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
  return result.kind === "ok" ? { ok: true, value: result.data } : { ok: false };
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
): Promise<ScopeShareInfo | null> {
  const result = await loadScopeFiles(apiOrigin, workspace, {
    repo: scope.repo,
    number: scope.pr ?? null,
    type: null,
  });
  return result.ok ? shareInfoFromScope(result.value) : null;
}

export function normalizeCreateResult(result: CreateFeedResult): CreateLiveLinkResult {
  if (result.kind === "limit") return { kind: "limit", limit: result.limit };
  if (result.kind === "ok") return { kind: "ok", id: result.data.id, url: result.data.url };
  return { kind: "error" };
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
