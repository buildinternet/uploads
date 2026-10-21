/**
 * Read-only view of experimental `ai.*` classifier metadata.
 *
 * The API writes these after a Flagship-gated put (`ai.classifier` is `v5`
 * on Jev Latest, `v6` when the image was resized, `skipped` with `ai.skip`
 * when the model does not see an image, `failed` with `ai.error` when the
 * call produced no label, or `v4` on the Luna try; older rows may say
 * `v1`–`v3`). Clients cannot set them. Used by the Storage
 * file-detail drawer and the public `/f/` share-page rail — never by
 * galleries, feeds, or PR comments.
 *
 * `other` and `unknown` (any case, surrounding space ignored) are empty for
 * the kind, surface, and screen chips, and they drop out of `ai.tags`.
 * A classifier-only row, including a skip, stays silent. A row that only
 * has those placeholders stays silent too. Stored metadata is unchanged.
 *
 * Internal safety flags (`ai.rating`, `ai.content`, `ai.secret`, `ai.pii`,
 * and each `ai.<flag>.confidence`) are never chips and never land in the
 * generic metadata list. The drawer and the public `/f/` page both read
 * through this module, so those keys stay off both surfaces.
 */

/** Classifier answers that mean "no useful chip". Compared after trim + lowercase. */
const PLACEHOLDER_CHIP_VALUES = new Set(["other", "unknown"]);

export interface AiLabels {
  /** Schema marker (`v4` Luna, `v5` Jev Latest, `v6` resized, `skipped`, or an older `v1`–`v3`); omitted when the file only has display keys. */
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
export const USER_PRIMARY_META_KEYS = ["screen", "path", "state"] as const;

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

function isPlaceholderChip(value: string): boolean {
  return PLACEHOLDER_CHIP_VALUES.has(value.toLowerCase());
}

/** Trimmed chip text, or undefined when blank or a placeholder (`other` / `unknown`). */
function displayChip(value: string | undefined): string | undefined {
  const trimmed = trimMeta(value);
  if (!trimmed || isPlaceholderChip(trimmed)) return undefined;
  return trimmed;
}

/**
 * Structured AI labels, or `null` when there is nothing to show.
 * Classifier-only rows stay silent. So do rows whose kind, surface, screen,
 * and tags are only `other` or `unknown`, with no summary.
 */
export function parseAiLabels(
  metadata: Record<string, string> | undefined | null,
): AiLabels | null {
  if (!metadata) return null;
  const kind = displayChip(metadata["ai.kind"]);
  const surface = displayChip(metadata["ai.surface"]);
  const screen = displayChip(metadata["ai.screen"]);
  const summary = trimMeta(metadata["ai.summary"]);
  const tags = splitAiTags(metadata["ai.tags"]).filter((tag) => !isPlaceholderChip(tag));
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

/** True when the drawer or share page would render an AI section. */
export function hasAiMetadata(metadata: Record<string, string> | undefined | null): boolean {
  return parseAiLabels(metadata) !== null;
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
