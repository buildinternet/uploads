/**
 * Required uploads (`.uploads.yml` `check.require`): what a PR that changes
 * UI files must carry for the `uploads.sh` check to pass, evaluated from
 * server-owned facts only. The checklist shows in the managed comment and in
 * the check's summary; a skip label (`check.skipLabels`) excuses the PR and
 * replaces the checklist with a "skipped" line in both.
 */
import type { CheckRequirement, ResolvedCommentOptions } from "@uploads/comment-config";
import { inferContentType, type ChecklistEntry, type GhTarget } from "./github-comment-render";
import { githubFetch, githubHeaders, repoInstallationToken } from "./github-app";
import { getMetadataForKeys } from "./file-metadata";
import { dbFor } from "./db-session";
import { extractIngestAttachments, extractRepoMediaLinks } from "./github-attachment-extract";

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

/** An attachment the checklist may count. `name` is the key or filename. */
export interface RequirementFile {
  contentType?: string | null;
  name?: string;
  meta?: Record<string, string>;
}

/**
 * True for `image/*` and `video/*`. A missing or generic stored type falls
 * back to the filename, the same way the comment picks a type.
 */
export function countsAsVisual(contentType: string | null | undefined, name?: string): boolean {
  const declared = contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const type =
    declared && declared !== "application/octet-stream" ? declared : inferContentType(name ?? "");
  return type.startsWith("image/") || type.startsWith("video/");
}

/**
 * Each requirement, met or not. Only images and videos in `files` count.
 * `extraCount` is other images and videos (a gallery that holds one, a held
 * image or video, a file attached on GitHub). Pure.
 */
export function requirementChecklist(
  require: readonly CheckRequirement[],
  files: readonly RequirementFile[],
  extraCount = 0,
): ChecklistEntry[] {
  const visual = files.filter((file) => countsAsVisual(file.contentType, file.name));
  const states = new Set(visual.map((file) => file.meta?.state));
  const surfaces = new Set(visual.map((file) => surfaceOf(file.meta)));
  const met: Record<CheckRequirement, boolean> = {
    uploads: visual.length + extraCount > 0,
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
 * Evaluate the requirements for a PR's shown attachments plus `extraCount`
 * images and videos that are not in that list. Only `image/*` and `video/*`
 * count. The label read and the metadata read are independent, so they overlap.
 */
export async function evaluateRequirement(
  env: Env,
  workspaceName: string,
  target: GhTarget,
  options: Pick<ResolvedCommentOptions, "checkRequire" | "checkSkipLabels">,
  files: readonly { key: string; contentType?: string | null }[],
  extraCount: number,
): Promise<Requirement> {
  const [skipLabel, metaByKey] = await Promise.all([
    skipLabelOnPr(env, target, options.checkSkipLabels),
    getMetadataForKeys(
      dbFor(env),
      workspaceName,
      files.map((file) => file.key),
      { metaKeys: REQUIREMENT_META_KEYS },
    ),
  ]);
  return {
    checklist: skipLabel
      ? []
      : requirementChecklist(
          options.checkRequire,
          files.map((file) => ({
            contentType: file.contentType,
            name: file.key,
            meta: metaByKey.get(file.key),
          })),
          extraCount,
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

/**
 * Images and videos linked from one GitHub body, or none for a bot's post
 * (import skips bots too). Media committed to the repo and linked by URL
 * counts as well, since some agents attach screenshots that way.
 */
function attachmentsIn(
  post: { body?: unknown; user?: { type?: unknown } } | null,
  repo: string,
): number {
  if (!post || post.user?.type === "Bot" || typeof post.body !== "string") return 0;
  return extractIngestAttachments(post.body).length + extractRepoMediaLinks(post.body, repo).length;
}

/**
 * Images and videos people attached on GitHub itself (dragged into the PR
 * description or a comment), counted from the text whether or not the
 * workspace imports them, so a contributor without uploads.sh still meets
 * the `uploads` requirement. Reads the first 100 comments only. Zero on any
 * GitHub failure.
 */
export async function githubAttachmentCount(
  env: Env,
  target: GhTarget,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  try {
    const token = await repoInstallationToken(env, target.repo, fetchImpl);
    if (!token) return 0;
    const base = `https://api.github.com/repos/${target.repo}/issues/${target.num}`;
    const [issue, comments] = await Promise.all(
      [base, `${base}/comments?per_page=100`].map(async (url) => {
        const res = await githubFetch(fetchImpl, url, { headers: githubHeaders(token) });
        return res.ok ? await res.json().catch(() => null) : null;
      }),
    );
    let count = attachmentsIn(issue as Parameters<typeof attachmentsIn>[0], target.repo);
    if (Array.isArray(comments)) for (const c of comments) count += attachmentsIn(c, target.repo);
    return count;
  } catch {
    return 0;
  }
}
