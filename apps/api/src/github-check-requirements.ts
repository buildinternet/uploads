/**
 * Required uploads (`.uploads.yml` `check.require`): what a PR that changes
 * UI files must carry for the `uploads.sh` check to pass, evaluated from
 * server-owned facts only. The checklist shows in the managed comment and in
 * the check's summary; a skip label (`check.skipLabels`) excuses the PR.
 */
import type { CheckRequirement } from "@uploads/comment-config";
import type { ChecklistEntry } from "./github-comment-render";
import { getMetadataForKeys } from "./file-metadata";
import { dbFor } from "./db-session";

const LABELS: Record<CheckRequirement, string> = {
  uploads: "Uploads",
  "before-after": "Before and after",
  desktop: "Desktop",
  mobile: "Mobile",
};

/** `state` from the upload, `ai.surface` from the classifier, dimensions as the fallback. */
export const REQUIREMENT_META_KEYS = [
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

/** The checklist for a PR's shown attachments plus `extraCount` galleries and held files. */
export async function gatherChecklist(
  env: Env,
  workspaceName: string,
  require: readonly CheckRequirement[],
  keys: readonly string[],
  extraCount: number,
): Promise<ChecklistEntry[]> {
  if (require.length === 0) return [];
  const metaByKey =
    keys.length > 0
      ? await getMetadataForKeys(dbFor(env), workspaceName, [...keys], {
          metaKeys: REQUIREMENT_META_KEYS,
        })
      : new Map<string, Record<string, string>>();
  return requirementChecklist(
    require,
    keys.length + extraCount,
    keys.map((k) => metaByKey.get(k)),
  );
}

/** The first of the PR's labels that is a skip label, compared case-insensitively. */
export function matchingSkipLabel(
  prLabels: readonly string[],
  skipLabels: readonly string[],
): string | null {
  const wanted = new Set(skipLabels.map((l) => l.toLowerCase()));
  return prLabels.find((l) => wanted.has(l.toLowerCase())) ?? null;
}
