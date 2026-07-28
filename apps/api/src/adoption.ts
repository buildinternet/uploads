/**
 * Adoption metrics recording (`daily_metrics` D1 table) — the operator
 * metrics surface's write side.
 *
 * Describes CHANGE OVER TIME only. `workspace_usage` (src/usage.ts) remains
 * the source of truth for current absolute stored bytes/objects; nothing here
 * should ever be used to derive current state.
 *
 * Like `recordUsageSafe`, metering is best-effort: `recordAdoptionSafe` logs
 * and continues on failure, because a metrics write must never fail an upload.
 */

export type AdoptionMetric =
  | "upload"
  | "delete"
  | "workspace_created"
  | "gallery_created"
  | "comment_posted"
  | "repo_linked";

/**
 * Which server-side entry point wrote an upload. There is no way to tell a
 * CLI request from any other API request server-side, so finer-grained client
 * identity comes from the provenance bag's `client` value instead.
 */
export type UploadSurface = "api" | "mcp" | "promote";

/** Analytics Engine dimensions. Never written to D1 — see the module docs. */
export interface AdoptionDimensions {
  surface?: UploadSurface;
  contentType?: string;
  client?: string;
  plan?: string;
  repo?: string;
}

export interface AdoptionEvent {
  metric: AdoptionMetric;
  workspace: string;
  /** Non-negative bytes attributable to this event. Omitted/negative → 0. */
  bytes?: number;
  dimensions?: AdoptionDimensions;
}

/** The platform-total row's workspace sentinel. */
const PLATFORM = "";

/** UTC calendar day as `YYYY-MM-DD` — the rollup bucket. */
export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Bytes are a non-negative magnitude; direction is carried by the metric. */
function normalizeBytes(bytes: number | undefined): number {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.round(bytes);
}

/**
 * Upsert the per-workspace row and the platform-total row for `event`.
 * Blind upserts — no preceding SELECT — issued as one batch so the pair is a
 * single round trip and cannot half-apply. Throws on D1 failure; callers on a
 * request path should use `recordAdoptionSafe` instead.
 */
export async function bumpDailyMetric(
  db: D1Database,
  event: AdoptionEvent,
  now = new Date(),
): Promise<void> {
  const day = utcDay(now);
  const bytes = normalizeBytes(event.bytes);
  const sql = `INSERT INTO daily_metrics (metric, day, workspace, count, bytes)
               VALUES (?, ?, ?, 1, ?)
               ON CONFLICT(metric, day, workspace) DO UPDATE SET
                 count = count + 1,
                 bytes = bytes + excluded.bytes`;
  await db.batch([
    db.prepare(sql).bind(event.metric, day, event.workspace, bytes),
    db.prepare(sql).bind(event.metric, day, PLATFORM, bytes),
  ]);
}

/**
 * Best-effort adoption recording: log and continue if the write fails.
 * Safe to await on any request path — it never throws.
 */
export async function recordAdoptionSafe(
  env: Env,
  event: AdoptionEvent,
  now = new Date(),
): Promise<void> {
  try {
    await bumpDailyMetric(env.DB, event, now);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        message: "adoption metric write failed",
        metric: event.metric,
        workspace: event.workspace,
        error: message,
      }),
    );
  }
}
