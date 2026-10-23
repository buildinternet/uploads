/**
 * Wire shapes and vocabulary for the operator classifier views
 * (`/admin-ui/classifier/*`). Env-free, and exported as
 * `@uploads/api/classifier-admin-wire`, so apps/web imports the runtime
 * constants from here rather than copying them. The classifier itself
 * (`classifier.ts`, `file-metadata.ts`) reads the field list and the
 * confidence buckets from this module too.
 *
 * "Flagged" means a stored safety answer that is not the clean value:
 * `ai.rating` other than `safe`, or `ai.content` / `ai.secret` / `ai.pii`
 * other than `none`. A missing key means the file was not classified or
 * the answer was under the confidence floor. It does not mean clean.
 */

/** Day windows every operator metrics view offers. Anything else is a 400. */
export const ADMIN_METRIC_WINDOWS = [7, 30, 90] as const;
export type ClassifierAdminWindow = (typeof ADMIN_METRIC_WINDOWS)[number];

/** The four internal safety questions, in display order. */
export const CLASSIFIER_SAFETY_FIELDS = ["rating", "content", "secret", "pii"] as const;
export type ClassifierSafetyField = (typeof CLASSIFIER_SAFETY_FIELDS)[number];

/** Coarse bucket stored on `ai.<flag>.confidence`. */
export const CLASSIFIER_CONFIDENCE_BUCKETS = ["high", "medium", "low"] as const;
export type ClassifierConfidenceBucket = (typeof CLASSIFIER_CONFIDENCE_BUCKETS)[number];

export function isConfidenceBucket(value: string | undefined): value is ClassifierConfidenceBucket {
  return (CLASSIFIER_CONFIDENCE_BUCKETS as readonly (string | undefined)[]).includes(value);
}

/**
 * The value that means "nothing to flag" for each safety field. A test
 * holds each one to a key of the classifier's criteria map.
 */
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
  /** Files whose `ai.classifier` is neither `skipped` nor `failed`. */
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
  /** `ai.ready` values: whether a screen had finished loading. */
  readiness: ClassifierValueCount[];
  flags: ClassifierFlagStats[];
  /** Files with at least one flagged field. */
  flaggedFiles: number;
  /**
   * One point per UTC day in the window, from the `updated_at` of each
   * `ai.classifier` row (the latest write, so a re-classified file moves).
   */
  daily: ClassifierDailyPoint[];
  /** Platform uploads in the window from `daily_metrics`, or null when unavailable. */
  windowUploads: number | null;
  /**
   * OpenRouter Decisions calls and their reported cost per UTC day, from
   * Analytics Engine. Unavailable when AE is unconfigured or the query fails.
   */
  costs: ClassifierCostSeries;
}

export interface ClassifierCostDay {
  day: string;
  /** Decisions calls, including hold-area box calls. */
  calls: number;
  /** Input tokens over every call. Jev bills input only. */
  inputTokens: number;
  /** Input tokens over the calls whose response carried a cost. */
  pricedInputTokens: number;
  /** USD summed over the calls that carried a cost. */
  cost: number;
}

export type ClassifierCostSeries =
  | { available: true; days: ClassifierCostDay[] }
  | { available: false; reason: string };

export interface ClassifierDailyPoint {
  day: string;
  classified: number;
  skipped: number;
  failed: number;
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

/** `GET /admin-ui/classifier/holds`: pending holds (upload-hold.ts). */
export interface ClassifierHoldsSummary {
  total: number;
  workspaces: { workspace: string; count: number }[];
}

/** `POST /admin-ui/classifier/holds/release`: one batch of the operator release. */
export interface ClassifierHoldsReleaseResult {
  released: number;
  failed: number;
  /** Holds still pending after this batch. */
  remaining: number;
}
