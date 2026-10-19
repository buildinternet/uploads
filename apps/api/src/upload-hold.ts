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
 * Where the flagged content sits, so a reviewer knows where to look:
 * `top,bottom,left,right` as fractions of the image (0 to 1, origin top
 * left), padded. Written after the hold by `locateHoldArea` in
 * `classifier.ts`. A pointer, not a redaction: it can be off or miss part
 * of the content. Absent when the model gave no usable box.
 */
export const HOLD_AREA_KEY = "ai.hold.area";

/**
 * Who released a hold and when, for the members-only Reviewed note on the
 * file page. `by` is a display label captured at approval (a member's
 * name, or a service token's label); `at` is an ISO timestamp. Cleared
 * when a file is held again.
 */
export const HOLD_BY_KEY = "ai.hold.by";
export const HOLD_AT_KEY = "ai.hold.at";

export interface HoldArea {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Fraction added to each side of a model box, clamped to the image. */
export const HOLD_AREA_PAD = 0.03;

/**
 * A model box padded by `HOLD_AREA_PAD` and clamped to the image, or
 * `undefined` when an edge is missing, not finite, or out of order.
 */
export function padHoldArea(box: unknown): HoldArea | undefined {
  if (!box || typeof box !== "object") return undefined;
  const { top, bottom, left, right } = box as Record<string, unknown>;
  const edges = [top, bottom, left, right];
  if (!edges.every((edge) => typeof edge === "number" && Number.isFinite(edge))) return undefined;
  const [t, b, l, r] = edges as number[];
  if (t >= b || l >= r) return undefined;
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  return {
    top: clamp(t - HOLD_AREA_PAD),
    bottom: clamp(b + HOLD_AREA_PAD),
    left: clamp(l - HOLD_AREA_PAD),
    right: clamp(r + HOLD_AREA_PAD),
  };
}

export function formatHoldArea(area: HoldArea): string {
  return [area.top, area.bottom, area.left, area.right].map((n) => n.toFixed(3)).join(",");
}

/** The stored `ai.hold.area` row, or `undefined` when absent or malformed. */
export function parseHoldArea(value: string | undefined): HoldArea | undefined {
  if (!value) return undefined;
  const parts = value.split(",").map(Number);
  if (parts.length !== 4) return undefined;
  if (!parts.every((n) => Number.isFinite(n) && n >= 0 && n <= 1)) return undefined;
  const [top, bottom, left, right] = parts;
  if (top >= bottom || left >= right) return undefined;
  return { top, bottom, left, right };
}

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
