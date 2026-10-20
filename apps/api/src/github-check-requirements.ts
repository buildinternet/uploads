/**
 * Required uploads (`.uploads.yml` `check.require`): what a PR that changes
 * UI files must carry for the `uploads.sh` check to pass, evaluated from
 * server-owned facts only. The checklist shows in the managed comment and in
 * the check's summary; a skip label (`check.skipLabels`) excuses the PR and
 * replaces the checklist with a "skipped" line in both.
 */
import type { CheckRequirement, ResolvedCommentOptions } from "@uploads/comment-config";
import type { ChecklistEntry, GhTarget } from "./github-comment-render";
import { githubFetch, githubHeaders, repoInstallationToken } from "./github-app";
import { getMetadataForKeys } from "./file-metadata";
import { dbFor } from "./db-session";

const LABELS: Record<CheckRequirement, string> = {
  uploads: "Uploads",
  "before-after": "Before and after",
  desktop: "Desktop",
  mobile: "Mobile",
};

/** `state` from the upload, `ai.surface` from the classifier, dimensions as the fallback. */
const REQUIREMENT_META_KEYS = [
  "state",
  "ai.surface",
  "image.width",
  "image.height",
  "video.width",
  "video.height",
];

/** Taller than 1.4:1 reads as a phone; wider than 1.2:1 as a computer screen. */
const MOBILE_RATIO = 1.4;
const DESKTOP_RATIO = 1.2;

/**
 * The device a file shows: the classifier's `ai.surface` when it said mobile
 * or desktop, else the shape of the frame. Null when neither tells.
 */
export function surfaceOf(meta: Record<string, string> | undefined): "mobile" | "desktop" | null {
  if (!meta) return null;
  const labelled = meta["ai.surface"];
  if (labelled === "mobile" || labelled === "desktop") return labelled;
  const w = Number(meta["image.width"] ?? meta["video.width"]);
  const h = Number(meta["image.height"] ?? meta["video.height"]);
  if (!(w > 0 && h > 0)) return null;
  if (h / w >= MOBILE_RATIO) return "mobile";
  if (w / h >= DESKTOP_RATIO) return "desktop";
  return null;
}

/** Each requirement, met or not, for `count` uploads whose metadata is `metas`. Pure. */
export function requirementChecklist(
  require: readonly CheckRequirement[],
  count: number,
  metas: readonly (Record<string, string> | undefined)[],
): ChecklistEntry[] {
  const states = new Set(metas.map((m) => m?.state));
  const surfaces = new Set(metas.map(surfaceOf));
  const met: Record<CheckRequirement, boolean> = {
    uploads: count > 0,
    "before-after": states.has("before") && states.has("after"),
    desktop: surfaces.has("desktop"),
    mobile: surfaces.has("mobile"),
  };
  return require.map((r) => ({ label: LABELS[r], met: met[r] }));
}

/**
 * Where a PR that changed UI files stands on the repo's requirements: excused
 * by `skipLabel`, or measured by `checklist`. The comment and the check both
 * render from this one value.
 */
export interface Requirement {
  checklist: ChecklistEntry[];
  skipLabel: string | null;
  /** The label a failing check suggests for skipping. */
  skipHint: string | undefined;
}

/**
 * Evaluate the requirements for a PR's shown attachment `keys` plus
 * `extraCount` galleries and held files. The label read and the metadata
 * read are independent, so they overlap.
 */
export async function evaluateRequirement(
  env: Env,
  workspaceName: string,
  target: GhTarget,
  options: Pick<ResolvedCommentOptions, "checkRequire" | "checkSkipLabels">,
  keys: string[],
  extraCount: number,
): Promise<Requirement> {
  const [skipLabel, metaByKey] = await Promise.all([
    skipLabelOnPr(env, target, options.checkSkipLabels),
    getMetadataForKeys(dbFor(env), workspaceName, keys, { metaKeys: REQUIREMENT_META_KEYS }),
  ]);
  return {
    checklist: skipLabel
      ? []
      : requirementChecklist(
          options.checkRequire,
          keys.length + extraCount,
          keys.map((k) => metaByKey.get(k)),
        ),
    skipLabel,
    skipHint: options.checkSkipLabels[0],
  };
}

/** The first of the PR's labels that is a skip label, compared case-insensitively. */
export function matchingSkipLabel(
  prLabels: readonly string[],
  skipLabels: readonly string[],
): string | null {
  const wanted = new Set(skipLabels.map((l) => l.toLowerCase()));
  return prLabels.find((l) => wanted.has(l.toLowerCase())) ?? null;
}

/**
 * The PR's label that excuses it, read fresh from GitHub. Null on no match
 * and on any GitHub failure: the requirement then stands, the safe side for
 * a check the repo chose to enforce.
 */
export async function skipLabelOnPr(
  env: Env,
  target: GhTarget,
  skipLabels: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (target.kind !== "pull" || skipLabels.length === 0) return null;
  try {
    const token = await repoInstallationToken(env, target.repo, fetchImpl);
    if (!token) return null;
    const res = await githubFetch(
      fetchImpl,
      `https://api.github.com/repos/${target.repo}/issues/${target.num}/labels?per_page=100`,
      { headers: githubHeaders(token) },
    );
    if (!res.ok) return null;
    const labels = (await res.json().catch(() => null)) as { name?: unknown }[] | null;
    if (!Array.isArray(labels)) return null;
    const names = labels.map((l) => l?.name).filter((n): n is string => typeof n === "string");
    return matchingSkipLabel(names, skipLabels);
  } catch {
    return null;
  }
}
