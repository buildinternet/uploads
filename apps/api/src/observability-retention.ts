/**
 * Daily purge of high-volume observability rows that only ever INSERT/UPDATE:
 * - uploads_telemetry_events (CLI/MCP command pings)
 * - auth_enrollments (used or long-expired invite codes)
 *
 * Modeled after apps/auth retention-sweep: SELECT ids LIMIT N → DELETE by id →
 * loop, with a per-table batch cap so a backlog cannot blow the Worker cron
 * CPU budget. Residual rows clear on subsequent days.
 */

export const TELEMETRY_RETENTION_DAYS = 30;
export const ENROLLMENT_RETENTION_DAYS = 7;

/** Rows deleted per SELECT/DELETE cycle. */
export const OBSERVABILITY_RETENTION_BATCH_SIZE = 500;
/** Max SELECT/DELETE cycles per table per cron run (~10k rows/table/day). */
export const OBSERVABILITY_RETENTION_MAX_BATCHES = 20;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface ObservabilityRetentionResult {
  telemetryDeleted: number;
  enrollmentsDeleted: number;
  telemetryTruncated: boolean;
  enrollmentsTruncated: boolean;
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

async function purgeTelemetry(
  db: D1Database,
  cutoffMs: number,
): Promise<{
  deleted: number;
  truncated: boolean;
}> {
  let deleted = 0;
  let truncated = false;

  for (let batch = 0; batch < OBSERVABILITY_RETENTION_MAX_BATCHES; batch++) {
    const { results } = await db
      .prepare(`SELECT id FROM uploads_telemetry_events WHERE timestamp < ? LIMIT ?`)
      .bind(cutoffMs, OBSERVABILITY_RETENTION_BATCH_SIZE)
      .all<{ id: string }>();

    if (!results || results.length === 0) break;

    const ids = results.map((r) => r.id);
    await db
      .prepare(`DELETE FROM uploads_telemetry_events WHERE id IN (${placeholders(ids.length)})`)
      .bind(...ids)
      .run();
    deleted += ids.length;

    if (ids.length < OBSERVABILITY_RETENTION_BATCH_SIZE) break;

    // Full batch at the last allowed cycle — more rows may remain.
    if (batch === OBSERVABILITY_RETENTION_MAX_BATCHES - 1) {
      truncated = true;
    }
  }

  return { deleted, truncated };
}

async function purgeEnrollments(
  db: D1Database,
  cutoffIso: string,
): Promise<{
  deleted: number;
  truncated: boolean;
}> {
  let deleted = 0;
  let truncated = false;

  for (let batch = 0; batch < OBSERVABILITY_RETENTION_MAX_BATCHES; batch++) {
    // Never delete unexpired unused enrollments: only rows past the retention
    // window on expires_at, or used rows whose used_at is past the window.
    const { results } = await db
      .prepare(
        `SELECT id FROM auth_enrollments
         WHERE expires_at < ?
            OR (used_at IS NOT NULL AND used_at < ?)
         LIMIT ?`,
      )
      .bind(cutoffIso, cutoffIso, OBSERVABILITY_RETENTION_BATCH_SIZE)
      .all<{ id: string }>();

    if (!results || results.length === 0) break;

    const ids = results.map((r) => r.id);
    await db
      .prepare(`DELETE FROM auth_enrollments WHERE id IN (${placeholders(ids.length)})`)
      .bind(...ids)
      .run();
    deleted += ids.length;

    if (ids.length < OBSERVABILITY_RETENTION_BATCH_SIZE) break;

    if (batch === OBSERVABILITY_RETENTION_MAX_BATCHES - 1) {
      truncated = true;
    }
  }

  return { deleted, truncated };
}

export async function runObservabilityRetention(
  env: Env,
  now = new Date(),
): Promise<ObservabilityRetentionResult> {
  if (!env.DB) {
    return {
      telemetryDeleted: 0,
      enrollmentsDeleted: 0,
      telemetryTruncated: false,
      enrollmentsTruncated: false,
    };
  }

  const cutoffMs = now.getTime() - TELEMETRY_RETENTION_DAYS * MS_PER_DAY;
  const enrollmentCutoff = new Date(now.getTime() - ENROLLMENT_RETENTION_DAYS * MS_PER_DAY);
  const cutoffIso = enrollmentCutoff.toISOString();

  const telemetry = await purgeTelemetry(env.DB, cutoffMs);
  const enrollments = await purgeEnrollments(env.DB, cutoffIso);

  const result: ObservabilityRetentionResult = {
    telemetryDeleted: telemetry.deleted,
    enrollmentsDeleted: enrollments.deleted,
    telemetryTruncated: telemetry.truncated,
    enrollmentsTruncated: enrollments.truncated,
  };

  console.log(
    JSON.stringify({
      message: "observability_retention",
      telemetryDeleted: result.telemetryDeleted,
      enrollmentsDeleted: result.enrollmentsDeleted,
      ...(result.telemetryTruncated || result.enrollmentsTruncated ? { truncated: true } : {}),
      ...(result.telemetryTruncated ? { telemetryTruncated: true } : {}),
      ...(result.enrollmentsTruncated ? { enrollmentsTruncated: true } : {}),
    }),
  );

  return result;
}
