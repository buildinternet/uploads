/**
 * Held uploads: a file the classifier flags for a credential or sensitive
 * personal data, with high confidence, is held for approval. A held file
 * works like a staged file. Its raw storage URL still serves the bytes, but
 * no surface this service publishes shows it: the managed PR comment, a
 * public feed or gallery, or the public `/f/` page. A workspace member
 * approves it with `POST /v1/workspaces/:workspace/files/approve`.
 *
 * State is one server-owned row, `ai.hold`: `pending` or `approved`. It is
 * in `CLASSIFIER_ROW_KEYS`, so it shares the classifier's lifetime:
 * identical bytes keep it (an approval sticks), and new bytes clear it.
 *
 * Env-free, so the CLI's local-gh comment path can share the predicate.
 */

import { CLASSIFIER_CLEAN_VALUES } from "./classifier-admin-wire";

export const HOLD_META_KEY = "ai.hold";
export const HOLD_PENDING = "pending";
export const HOLD_APPROVED = "approved";

/**
 * `ai.pii` values that hold a file. `contact` is left out: product
 * screenshots show forms and directories all the time, and a held
 * screenshot breaks a PR comment.
 */
export const HOLD_PII_VALUES: ReadonlySet<string> = new Set([
  "identity_document",
  "financial",
  "other",
]);

export type HoldReason = "secret" | "pii";

/**
 * Why a set of classifier rows should hold the file, or `undefined`. Only a
 * `high` confidence bucket counts.
 */
export function holdReason(meta: Record<string, string> | undefined): HoldReason | undefined {
  if (!meta) return undefined;
  const secret = meta["ai.secret"];
  if (
    secret !== undefined &&
    secret !== CLASSIFIER_CLEAN_VALUES.secret &&
    meta["ai.secret.confidence"] === "high"
  ) {
    return "secret";
  }
  const pii = meta["ai.pii"];
  if (pii !== undefined && HOLD_PII_VALUES.has(pii) && meta["ai.pii.confidence"] === "high") {
    return "pii";
  }
  return undefined;
}

/**
 * Shown in place of a held file's name on public feeds and galleries. The
 * name plus the repo and PR is enough to build a public repo's raw URL.
 */
export const HELD_FILENAME = "held for review";

/** A file is held while its `ai.hold` row is `pending`. */
export function isHeld(meta: Record<string, string> | undefined): boolean {
  return meta?.[HOLD_META_KEY] === HOLD_PENDING;
}

/** The workspace switch. On unless the record says `false`. */
export function holdPolicyEnabled(ws: { holdFlaggedUploads?: boolean }): boolean {
  return ws.holdFlaggedUploads !== false;
}
