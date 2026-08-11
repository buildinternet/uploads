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

/**
 * Every adoption metric. The union is DERIVED from this array so the two can
 * never drift — `featureTotals` iterates it to issue one index-seeking query
 * per metric (see adoption-queries.ts).
 */
export const ADOPTION_METRICS = [
  "upload",
  "delete",
  "workspace_created",
  "gallery_created",
  "comment_posted",
  "comment_actor_dryrun_decline",
  "repo_linked",
] as const;

export type AdoptionMetric = (typeof ADOPTION_METRICS)[number];

/**
 * Which server-side entry point wrote an upload. There is no way to tell a
 * CLI request from any other API request server-side, so finer-grained client
 * identity comes from the provenance bag's `client` value instead.
 */
export type UploadSurface = "api" | "mcp" | "promote" | "github";

/**
 * Analytics Engine dimensions. Never written to D1 — see the module docs.
 *
 * Deliberately excludes `plan`: `BLOB_ORDER` below still reserves a blob slot
 * for it (so `repo`'s ordinal never shifts), but no caller populates it, so
 * it is not exposed as something callers can set. See `BLOB_ORDER`'s comment.
 */
export interface AdoptionDimensions {
  surface?: UploadSurface;
  contentType?: string;
  client?: string;
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
  // An empty workspace IS the platform sentinel, so writing both statements
  // would make the second ON CONFLICT fire against the first's own insert and
  // double-count. Collapse to a single row in that case.
  const workspaces = event.workspace === PLATFORM ? [PLATFORM] : [event.workspace, PLATFORM];
  await db.batch(
    workspaces.map((workspace) => db.prepare(sql).bind(event.metric, day, workspace, bytes)),
  );
}

/**
 * Blob positions are a contract with the SQL read path (analytics-engine.ts)
 * — Analytics Engine has no column names, only ordinals. Append new
 * dimensions at the END; never reorder or remove, or historical rows change
 * meaning retroactively.
 *
 * This is the SINGLE SOURCE OF TRUTH for that ordinal contract: the write
 * side (`writeAdoptionPoint`'s `blobs` array, below) and the read side
 * (analytics-engine.ts's `BLOB_COLUMN`) both derive from this array rather
 * than hand-repeating the ordering, so adding a dimension in the wrong
 * position is now a one-place change instead of three hand-synced copies.
 *
 * `"plan"` (blob5) is reserved but deliberately unpopulated — see
 * `AdoptionDimensions`'s comment. It stays in this array (rather than being
 * removed) purely to hold `"repo"` at blob6: removing it would shift `repo`
 * to blob5 and silently reinterpret every historical AE row, which AE has no
 * way to backfill. `writeAdoptionPoint` always emits `""` at this position.
 */
export const BLOB_ORDER = [
  "workspace",
  "surface",
  "contentType",
  "client",
  "plan",
  "repo",
] as const;

type BlobKey = (typeof BLOB_ORDER)[number];

/** The value written at `key`'s blob position for one adoption event. */
function blobValue(key: BlobKey, event: AdoptionEvent, d: AdoptionDimensions): string {
  switch (key) {
    case "workspace":
      return event.workspace;
    case "surface":
      return d.surface ?? "";
    case "contentType":
      return d.contentType ?? "";
    case "client":
      return d.client ?? "";
    case "plan":
      // Reserved-but-unpopulated slot (see BLOB_ORDER's comment) — no caller
      // sets this today. Always "" so blob5 stays a stable, empty column.
      return "";
    case "repo":
      return d.repo ?? "";
  }
}

/**
 * One wide data point per upload. Upload-only by design: the other metrics are
 * low-volume and fully served by D1, so sending them here would add a second
 * place to look without adding an answer.
 *
 * Never throws and never awaits — an absent binding (self-hosters, tests,
 * local dev) is a silent no-op.
 */
export function writeAdoptionPoint(env: Env, event: AdoptionEvent): void {
  if (event.metric !== "upload") return;
  const analytics = (env as { ANALYTICS?: AnalyticsEngineDataset }).ANALYTICS;
  if (!analytics) return;
  const d = event.dimensions ?? {};
  try {
    analytics.writeDataPoint({
      // Sampling key: keeps one workspace's traffic from crowding out another.
      indexes: [event.workspace],
      // Derived from BLOB_ORDER (not hand-listed) so this can never drift
      // from the ordinal contract documented there.
      blobs: BLOB_ORDER.map((key) => blobValue(key, event, d)),
      doubles: [normalizeBytes(event.bytes)],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ message: "adoption analytics write failed", error: message }));
  }
}

/**
 * Shared adoption-write-failure log shape. Exported so every caller that
 * swallows a `bumpDailyMetric`/`recordAdoptionSafe`-style failure (e.g.
 * github-repo-links.ts's `recordRepoLink`, which cannot await
 * `recordAdoptionSafe` directly — see that file's header comment) logs the
 * same one line instead of hand-rolling a copy that silently drifts.
 */
export function logAdoptionFailure(metric: AdoptionMetric, workspace: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    JSON.stringify({ message: "adoption metric write failed", metric, workspace, error: message }),
  );
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
  writeAdoptionPoint(env, event);
  try {
    await bumpDailyMetric(env.DB, event, now);
  } catch (err) {
    logAdoptionFailure(event.metric, event.workspace, err);
  }
}
