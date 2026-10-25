import { ghMetadataForBranch } from "@buildinternet/uploads";
import { optPosInt, optString, usage } from "@buildinternet/uploads/mcp";
import { unwrapFeedMutation } from "@uploads/api/feed-service";
import { normalizeFeedRepo } from "@uploads/api/feeds";
import { findOpenPullForBranch, repoBoundToWorkspace } from "@uploads/api/github-pull-context";
import type { MediaContext, StagedScope } from "./staged-media-response";

export function mediaScope(args: Record<string, unknown>): StagedScope {
  const repo = unwrapFeedMutation(normalizeFeedRepo(optString(args, "repo"))).value;
  const rawBranch = optString(args, "branch");
  if (!rawBranch || rawBranch.trim() !== rawBranch)
    usage("branch must be an explicit non-empty branch name without surrounding whitespace");
  try {
    return { repo, branch: ghMetadataForBranch(repo, rawBranch)["gh.branch"]! };
  } catch (error) {
    return usage(error instanceof Error ? error.message : String(error));
  }
}

export function mediaPr(args: Record<string, unknown>): number | undefined {
  const pr = optPosInt(args, "pr");
  if (pr !== undefined && !Number.isSafeInteger(pr)) usage("pr must be a safe positive integer");
  return pr;
}

/** GitHub lookups are permitted only for repositories linked to this workspace. */
export async function resolveMediaContext(
  env: Env,
  workspaceName: string,
  args: Record<string, unknown>,
): Promise<MediaContext> {
  const scope = mediaScope(args);
  const explicit = mediaPr(args);
  if (explicit !== undefined) return { ...scope, pr: explicit, prResolution: "explicit" };
  if (!(await repoBoundToWorkspace(env, scope.repo, workspaceName)))
    return { ...scope, pr: null, prResolution: "unavailable" };
  // GitHub branch names are case-sensitive; normalized staging metadata is not.
  const pr = await findOpenPullForBranch(env, scope.repo, optString(args, "branch")!);
  return { ...scope, pr, prResolution: pr === null ? "unavailable" : "resolved" };
}
