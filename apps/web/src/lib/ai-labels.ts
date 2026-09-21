/**
 * Read-only view of experimental `ai.*` classifier metadata.
 *
 * The API writes these after a Flagship-gated put (`ai.classifier` is `v1`,
 * `v2`, or `v3`). Clients cannot set them. Used by the Storage file-detail drawer
 * and the public `/f/` share-page rail — never by galleries, feeds, or
 * PR comments.
 */

const DISPLAY_KEYS = ["ai.kind", "ai.surface", "ai.screen", "ai.tags", "ai.summary"] as const;

export interface AiLabels {
  /** Schema marker (`v1` / `v2` / `v3`); omitted when the file only has display keys. */
  classifier?: string;
  kind?: string;
  surface?: string;
  screen?: string;
  tags: string[];
  summary?: string;
}

/** Closed-enum chips, in the order the drawer shows them. */
export const AI_CHIP_FIELDS = ["screen", "surface", "kind"] as const;
export type AiChipField = (typeof AI_CHIP_FIELDS)[number];

/** Human `path` / `state` stay primary when both are present. */
export const USER_PRIMARY_META_KEYS = ["path", "state"] as const;

export interface FileDetailMeta {
  /** `path` then `state`, only when set. */
  primary: Array<{ key: (typeof USER_PRIMARY_META_KEYS)[number]; value: string }>;
  /** Remaining non-`gh.*` / non-`ai.*` pairs, sorted by key. */
  other: Array<{ key: string; value: string }>;
  ai: AiLabels | null;
}

/** Comma-split `ai.tags`, dropping empties. */
export function splitAiTags(value: string | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of value.split(",")) {
    const tag = part.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

function trimMeta(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Structured AI labels, or `null` when there is nothing to show.
 * Classifier-only (no kind/surface/screen/tags/summary) stays silent.
 */
export function parseAiLabels(
  metadata: Record<string, string> | undefined | null,
): AiLabels | null {
  if (!metadata) return null;
  const kind = trimMeta(metadata["ai.kind"]);
  const surface = trimMeta(metadata["ai.surface"]);
  const screen = trimMeta(metadata["ai.screen"]);
  const summary = trimMeta(metadata["ai.summary"]);
  const tags = splitAiTags(metadata["ai.tags"]);
  if (!kind && !surface && !screen && !summary && tags.length === 0) return null;
  return {
    classifier: trimMeta(metadata["ai.classifier"]),
    kind,
    surface,
    screen,
    tags,
    summary,
  };
}

/** True when any `ai.*` display key or `ai.classifier` is present. */
export function hasAiMetadata(metadata: Record<string, string> | undefined | null): boolean {
  if (!metadata) return false;
  if (trimMeta(metadata["ai.classifier"])) return parseAiLabels(metadata) !== null;
  return DISPLAY_KEYS.some((key) => trimMeta(metadata[key]));
}

export function splitFileDetailMeta(
  metadata: Record<string, string> | undefined | null,
): FileDetailMeta {
  const primary: FileDetailMeta["primary"] = [];
  if (metadata) {
    for (const key of USER_PRIMARY_META_KEYS) {
      const value = trimMeta(metadata[key]);
      if (value) primary.push({ key, value });
    }
  }

  const other: FileDetailMeta["other"] = [];
  if (metadata) {
    for (const [key, raw] of Object.entries(metadata)) {
      if (key.startsWith("gh.") || key.startsWith("ai.")) continue;
      if ((USER_PRIMARY_META_KEYS as readonly string[]).includes(key)) continue;
      const value = trimMeta(raw);
      if (value) other.push({ key, value });
    }
    other.sort((a, b) => a.key.localeCompare(b.key));
  }

  return { primary, other, ai: parseAiLabels(metadata) };
}
