/**
 * Held uploads: a file the classifier flags for a credential or sensitive
 * personal data, with high confidence, is held for approval. A held file
 * works like a staged file: no surface this service publishes shows it (the
 * managed PR comment, a public feed or gallery, the public `/f/` page). On
 * hosted storage its bytes also leave the public bucket for the held bucket
 * (`held-storage.ts`), so its raw URL 404s. A workspace member approves it
 * with `POST /v1/workspaces/:workspace/files/approve`, which moves the
 * bytes back to the same key.
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
 * `1` while the bytes sit in the held bucket (`held-storage.ts`) instead of
 * at the public key. Absent for a BYO file, whose bytes never move.
 */
export const HOLD_MOVED_KEY = "ai.hold.moved";

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
 * The reason a held file was held, read back from its stored rows (the
 * confidence that triggered the hold is not re-checked). `secret: api_key`
 * or `pii: financial`.
 */
export function storedHoldReason(meta: Record<string, string> | undefined): string | null {
  const secret = meta?.["ai.secret"];
  if (secret && secret !== CLASSIFIER_CLEAN_VALUES.secret) return `secret: ${secret}`;
  const pii = meta?.["ai.pii"];
  if (pii && pii !== CLASSIFIER_CLEAN_VALUES.pii) return `pii: ${pii}`;
  return null;
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

/**
 * The first CLI release with `uploads approve`. A hold is only placed for an
 * upload from this CLI or newer: anything else (an older CLI, a script, the
 * web) could not release it, so its would-be holds are logged instead.
 */
export const HOLD_MIN_CLI_VERSION = "0.59.0";

/**
 * Whether an upload's client can act on a hold: our CLI (or its local MCP)
 * at `HOLD_MIN_CLI_VERSION` or newer. `client` is `parseCliUserAgent`'s
 * result for the upload request.
 */
export function clientCanApprove(
  client: { surface: string; clientVersion: string | null } | null | undefined,
): boolean {
  if (!client || (client.surface !== "cli" && client.surface !== "mcp-local")) return false;
  const have = semverTriple(client.clientVersion);
  const need = semverTriple(HOLD_MIN_CLI_VERSION);
  if (!have || !need) return false;
  for (let i = 0; i < 3; i++) {
    if (have[i] !== need[i]) return have[i] > need[i];
  }
  return true;
}

function semverTriple(version: string | null): [number, number, number] | null {
  const match = version ? /^(\d+)\.(\d+)\.(\d+)/.exec(version) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** The workspace switch. On unless the record says `false`. */
export function holdPolicyEnabled(ws: { holdFlaggedUploads?: boolean }): boolean {
  return ws.holdFlaggedUploads !== false;
}
