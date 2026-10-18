/**
 * Wire shapes for the operator classifier views (`/admin-ui/classifier/*`).
 * Env-free so apps/web can import the types through `@uploads/api/admin-ui`.
 *
 * "Flagged" means a stored safety answer that is not the clean value:
 * `ai.rating` other than `safe`, or `ai.content` / `ai.secret` / `ai.pii`
 * other than `none`. A missing key means the file was not classified or
 * the answer was under the confidence floor. It does not mean clean.
 */

export const CLASSIFIER_ADMIN_WINDOWS = [7, 30, 90] as const;
export type ClassifierAdminWindow = (typeof CLASSIFIER_ADMIN_WINDOWS)[number];

export type ClassifierSafetyField = "rating" | "content" | "secret" | "pii";
export type ClassifierConfidenceBucket = "high" | "medium" | "low";

/** The value that means "nothing to flag" for each safety field. */
export const CLASSIFIER_CLEAN_VALUES: Record<ClassifierSafetyField, string> = {
  rating: "safe",
  content: "none",
  secret: "none",
  pii: "none",
};

export interface ClassifierValueCount {
  value: string;
  count: number;
}

export interface ClassifierFlagStats {
  field: ClassifierSafetyField;
  /** Files with a stored answer for this field. */
  answered: number;
  /** Answered files whose value is not the clean value. */
  flagged: number;
  /** Every stored value, clean value included, highest count first. */
  values: ClassifierValueCount[];
  /** Confidence buckets for the flagged answers only. */
  flaggedConfidence: Record<ClassifierConfidenceBucket, number>;
}

/**
 * `GET /admin-ui/classifier/overview?days=7|30|90&fresh=1`.
 * Totals are all-time counts of stored rows. `daily` and `windowUploads`
 * cover the selected window.
 */
export interface ClassifierOverview {
  generatedAt: string;
  days: ClassifierAdminWindow;
  /** Distinct workspaces with any `ai.classifier` row. */
  workspaces: number;
  /** `ai.classifier` values (`v4`, `v5`, `v6`, `skipped`, older `v1`-`v3`). */
  versions: ClassifierValueCount[];
  /** Files whose `ai.classifier` is not `skipped`. */
  classified: number;
  skipped: number;
  /** `ai.skip` values. */
  skipReasons: ClassifierValueCount[];
  /** Files whose ai.classifier is failed. */
  failed: number;
  /** ai.error values. */
  errorReasons: ClassifierValueCount[];
  kinds: ClassifierValueCount[];
  surfaces: ClassifierValueCount[];
  screens: ClassifierValueCount[];
  flags: ClassifierFlagStats[];
  /** Files with at least one flagged field. */
  flaggedFiles: number;
  /**
   * One point per UTC day in the window, from the `updated_at` of each
   * `ai.classifier` row (the latest write, so a re-classified file moves).
   */
  daily: Array<{ day: string; classified: number; skipped: number; failed: number }>;
  /** Platform uploads in the window from `daily_metrics`, or null when unavailable. */
  windowUploads: number | null;
}

export interface ClassifierFlaggedFile {
  workspace: string;
  key: string;
  /** Flagged fields only, in `rating`, `content`, `secret`, `pii` order. */
  flags: Array<{
    field: ClassifierSafetyField;
    value: string;
    confidence: ClassifierConfidenceBucket | null;
  }>;
  /** `ai.classifier`, `ai.kind`, `ai.surface`, `ai.screen` when stored. */
  classifier: string | null;
  kind: string | null;
  surface: string | null;
  screen: string | null;
  /** Latest `updated_at` among the flagged rows. */
  flaggedAt: string;
}

/**
 * `GET /admin-ui/classifier/flagged?field=&confidence=&workspace=&cursor=&limit=`.
 * `field` is one safety field or omitted for all. `confidence=high` keeps
 * files with at least one high-confidence flag. Newest `flaggedAt` first.
 * `nextCursor` is opaque; pass it back as `cursor`.
 */
export interface ClassifierFlaggedPage {
  files: ClassifierFlaggedFile[];
  nextCursor: string | null;
}
