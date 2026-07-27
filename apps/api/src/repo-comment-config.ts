/**
 * Repo-level managed-comment config (`.uploads.yml` / issue #307). Fetches
 * one of six candidate paths from the repo's default branch via the GitHub
 * App installation, KV-caches the result (found or not-found alike), and
 * resolves it against the calling workspace's own defaults into the render
 * options `attachmentsCommentBody` consumes.
 *
 * Cache policy (KV, `repocfg:<repo>`, `REPO_CONFIG_TTL_SECONDS`):
 * - Found + parsed (even with warnings), or all six candidates 404 → cached.
 *   A committed-but-broken file shouldn't re-fetch on every render, and a
 *   repo with no config shouldn't either.
 * - Anything transient — a non-404 contents-API failure, no App config, no
 *   installation, a token-mint failure — degrades to "not found", uncached,
 *   so the next call retries instead of pinning a bad state for the TTL.
 */

import { parseRepoCommentConfig, resolveCommentOptions } from "@uploads/comment-config";
import type {
  OptionSource,
  RepoCommentConfig,
  ResolvedCommentOptions,
  WorkspaceCommentDefaults,
} from "@uploads/comment-config";
import {
  githubAppConfig,
  githubFetch,
  githubHeaders,
  installationForRepo,
  installationToken,
} from "./github-app";
import type { WorkspaceRecord } from "./workspace";

export interface RepoConfigFetchResult {
  found: boolean;
  path: string | null; // which candidate matched
  config: RepoCommentConfig | null;
  warnings: string[];
}

export const REPO_CONFIG_TTL_SECONDS = 300;

/** Candidate paths, checked in this order — the first hit wins. */
export const REPO_CONFIG_PATHS = [
  ".uploads.yml",
  ".uploads.yaml",
  ".uploads.json",
  ".github/uploads.yml",
  ".github/uploads.yaml",
  ".github/uploads.json",
] as const;

const NOT_FOUND: RepoConfigFetchResult = {
  found: false,
  path: null,
  config: null,
  warnings: [],
};

const cacheKeyFor = (repo: string) => `repocfg:${repo}`;

/** Best-effort KV write — a quota/transient rejection must not surface into the render path. */
async function cachePut(env: Env, cacheKey: string, result: RepoConfigFetchResult): Promise<void> {
  try {
    await env.GITHUB_CACHE.put(cacheKey, JSON.stringify(result), {
      expirationTtl: REPO_CONFIG_TTL_SECONDS,
    });
  } catch {
    // Cache write failed (quota, transient KV error, etc.) — the result is
    // still returned to the caller; the next call just re-fetches.
  }
}

/**
 * Fetch + KV-cache `repo`'s `.uploads.yml` (or one of its five siblings). See
 * the module doc-comment for the cache policy. Never throws — any failure to
 * obtain App credentials or an installation token degrades to `NOT_FOUND`,
 * uncached.
 */
export async function fetchRepoCommentConfig(
  env: Env,
  repo: string,
): Promise<RepoConfigFetchResult> {
  const cacheKey = cacheKeyFor(repo);
  const cached = (await env.GITHUB_CACHE.get(cacheKey, "json")) as RepoConfigFetchResult | null;
  if (cached) return cached;

  const appCfg = githubAppConfig(env);
  if (!appCfg) return NOT_FOUND; // no App creds configured — fail closed, uncached

  const installationId = await installationForRepo(env, appCfg, repo);
  if (installationId === null) return NOT_FOUND; // not installed — uncached

  const token = await installationToken(env, appCfg, installationId);
  if (!token) return NOT_FOUND; // token mint failed — uncached

  for (const path of REPO_CONFIG_PATHS) {
    let res: Response;
    try {
      res = await githubFetch(fetch, `https://api.github.com/repos/${repo}/contents/${path}`, {
        headers: { ...githubHeaders(token), accept: "application/vnd.github.raw+json" },
      });
    } catch {
      return NOT_FOUND; // transient (network/timeout) — uncached
    }
    if (res.status === 404) continue;
    if (!res.ok) return NOT_FOUND; // transient (5xx, rate limit, etc.) — uncached

    let text: string;
    try {
      text = await res.text();
    } catch {
      return NOT_FOUND; // transient (truncated/aborted body) — uncached
    }
    const format = path.endsWith(".json") ? "json" : "yaml";
    const { config, warnings } = parseRepoCommentConfig(text, format);
    const result: RepoConfigFetchResult = { found: true, path, config, warnings };
    await cachePut(env, cacheKey, result);
    return result;
  }

  // All six candidates 404 — a real, cacheable "no config" result.
  await cachePut(env, cacheKey, NOT_FOUND);
  return NOT_FOUND;
}

/** Map a workspace record's `githubComment*` fields onto workspace-tier comment defaults. */
export function workspaceCommentDefaults(ws: WorkspaceRecord): WorkspaceCommentDefaults {
  const defaults: WorkspaceCommentDefaults = {};
  if (ws.githubCommentImageWidth !== undefined) defaults.imageWidth = ws.githubCommentImageWidth;
  if (ws.githubCommentMaxInlineImages !== undefined)
    defaults.maxInlineImages = ws.githubCommentMaxInlineImages;
  if (ws.githubCommentShowMetadata !== undefined)
    defaults.showMetadata = ws.githubCommentShowMetadata;
  if (ws.githubCommentLinkToFilePage !== undefined)
    defaults.linkToFilePage = ws.githubCommentLinkToFilePage;
  if (ws.githubCommentNote !== undefined) defaults.note = ws.githubCommentNote;
  return defaults;
}

/**
 * Fetch `repo`'s config (cached) and resolve it against `ws`'s own defaults
 * into the final render options. Never throws — a fetch degradation simply
 * means the resolution proceeds with `config: null` (workspace-defaults/auto
 * only), matching `fetchRepoCommentConfig`'s own fail-closed behavior.
 */
export async function resolveRepoCommentOptions(
  env: Env,
  ws: WorkspaceRecord,
  repo: string,
): Promise<{
  options: ResolvedCommentOptions;
  source: Record<keyof ResolvedCommentOptions, OptionSource>;
  fetch: RepoConfigFetchResult;
}> {
  const fetchResult = await fetchRepoCommentConfig(env, repo);
  const { options, source } = resolveCommentOptions(
    fetchResult.config,
    workspaceCommentDefaults(ws),
  );
  return { options, source, fetch: fetchResult };
}
