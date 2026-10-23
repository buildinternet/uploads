/**
 * Read side of the operator classifier views. Pure `(db, ...)` helpers over
 * `file_metadata` (EAV, one row per key), no Hono dependency.
 *
 * D1 bills rows read. Every query seeks `file_metadata_ai_idx`, which needs
 * a bound `meta_key` and the literal partial-index predicate (`aiRows`) in
 * the same conjunction. A "flagged" read is split into `meta_value < clean`
 * and `meta_value > clean` legs so it seeks only the flagged rows instead
 * of every answer. The overview is cached in KV by the route.
 */

import { platformSeries, windowStart } from "./adoption-queries";
import {
  CLASSIFIER_CLEAN_VALUES,
  CLASSIFIER_SAFETY_FIELDS,
  isConfidenceBucket,
  type ClassifierAdminWindow,
  type ClassifierCostSeries,
  type ClassifierDailyPoint,
  type ClassifierFlagStats,
  type ClassifierFlaggedFile,
  type ClassifierFlaggedPage,
  type ClassifierOverview,
  type ClassifierSafetyField,
  type ClassifierValueCount,
} from "./classifier-admin-wire";
import { fillDaySeries } from "./day-series";
import type { D1Queryable } from "./db-session";
import { getMetadataForKeys } from "./file-metadata";
import { encodeCursorEnvelope, invalidCursor, parseCursorEnvelope } from "./pr-scope";

export const CLASSIFIER_CACHE_TTL = 600;
export const CLASSIFIER_FLAGGED_DEFAULT_LIMIT = 50;
export const CLASSIFIER_FLAGGED_MAX_LIMIT = 200;

export function classifierCacheKey(days: number): string {
  return `metrics:classifier:v1:${days}`;
}

/**
 * Must match the `WHERE` of `file_metadata_ai_idx` (migration
 * 20261018000000) exactly, or SQLite scans the table. `alias` is `""` or
 * a table prefix such as `"f."`.
 */
export const aiRows = (alias: string) => `substr(${alias}meta_key, 1, 3) = 'ai.'`;

const flagKey = (field: ClassifierSafetyField) => `ai.${field}`;
const confidenceKey = (field: ClassifierSafetyField) => `ai.${field}.confidence`;

/** Label keys counted by value in the overview, safety answers included. */
const COUNTED_KEYS = [
  "ai.skip",
  "ai.error",
  "ai.kind",
  "ai.surface",
  "ai.screen",
  "ai.ready",
  ...CLASSIFIER_SAFETY_FIELDS.map(flagKey),
];

const EMPTY_BUCKETS = (): ClassifierFlagStats["flaggedConfidence"] => ({
  high: 0,
  medium: 0,
  low: 0,
});

/**
 * The stored non-clean answers for `fields`, as a flat OR of range legs so
 * each leg is an index seek. With `highOnly`, each leg also requires its
 * own `.confidence` row to be `high`.
 */
function flaggedWhere(
  fields: readonly ClassifierSafetyField[],
  alias = "",
  opts: { highOnly?: boolean } = {},
): { sql: string; binds: string[] } {
  const high = opts.highOnly
    ? ` AND EXISTS (SELECT 1 FROM file_metadata c WHERE c.workspace = ${alias}workspace
        AND c.object_key = ${alias}object_key AND c.meta_key = ? AND c.meta_value = 'high')`
    : "";
  const legs: string[] = [];
  const binds: string[] = [];
  for (const field of fields) {
    for (const op of ["<", ">"]) {
      legs.push(
        `(${alias}meta_key = ? AND ${aiRows(alias)} AND ${alias}meta_value ${op} ?${high})`,
      );
      binds.push(flagKey(field), CLASSIFIER_CLEAN_VALUES[field]);
      if (opts.highOnly) binds.push(confidenceKey(field));
    }
  }
  return { sql: legs.join(" OR "), binds };
}

const sum = (rows: ClassifierValueCount[]) => rows.reduce((total, v) => total + v.count, 0);

const byCountDesc = (a: ClassifierValueCount, b: ClassifierValueCount) =>
  b.count - a.count || a.value.localeCompare(b.value);

/** One pass over every counted label key: `meta_key -> value counts`, highest first. */
async function labelCounts(db: D1Queryable): Promise<Map<string, ClassifierValueCount[]>> {
  const result = await db
    .prepare(
      `SELECT meta_key AS key, meta_value AS value, COUNT(*) AS count FROM file_metadata
       WHERE meta_key IN (${COUNTED_KEYS.map(() => "?").join(", ")}) AND ${aiRows("")}
       GROUP BY meta_key, meta_value`,
    )
    .bind(...COUNTED_KEYS)
    .all<{ key: string; value: string; count: number }>();
  const byKey = new Map<string, ClassifierValueCount[]>(COUNTED_KEYS.map((k) => [k, []]));
  for (const row of result.results) {
    byKey.get(row.key)?.push({ value: row.value, count: Number(row.count) });
  }
  for (const counts of byKey.values()) counts.sort(byCountDesc);
  return byKey;
}

/** Confidence buckets of every flagged answer, per field, in one join. */
async function flaggedConfidence(
  db: D1Queryable,
): Promise<Map<string, ClassifierFlagStats["flaggedConfidence"]>> {
  const { sql, binds } = flaggedWhere(CLASSIFIER_SAFETY_FIELDS, "f.");
  const result = await db
    .prepare(
      `SELECT f.meta_key AS key, c.meta_value AS bucket, COUNT(*) AS count
       FROM file_metadata f
       JOIN file_metadata c ON c.workspace = f.workspace AND c.object_key = f.object_key
         AND c.meta_key = f.meta_key || '.confidence'
       WHERE ${sql}
       GROUP BY f.meta_key, c.meta_value`,
    )
    .bind(...binds)
    .all<{ key: string; bucket: string; count: number }>();
  const byKey = new Map(CLASSIFIER_SAFETY_FIELDS.map((f) => [flagKey(f), EMPTY_BUCKETS()]));
  for (const row of result.results) {
    const buckets = byKey.get(row.key);
    if (buckets && isConfidenceBucket(row.bucket)) buckets[row.bucket] = Number(row.count);
  }
  return byKey;
}

async function flaggedFileCount(db: D1Queryable): Promise<number> {
  const { sql, binds } = flaggedWhere(CLASSIFIER_SAFETY_FIELDS);
  const row = await db
    .prepare(
      `SELECT COUNT(DISTINCT workspace || char(31) || object_key) AS n FROM file_metadata
       WHERE ${sql}`,
    )
    .bind(...binds)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function workspaceCount(db: D1Queryable): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(DISTINCT workspace) AS n FROM file_metadata
       WHERE meta_key = 'ai.classifier' AND ${aiRows("")}`,
    )
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

const zeroPoint = (day: string): ClassifierDailyPoint => ({
  day,
  classified: 0,
  skipped: 0,
  failed: 0,
});

/**
 * Every `ai.classifier` row grouped by write day and marker. All-time
 * version counts are the sum over days, and the daily series is the rows
 * inside the window, so one read serves both.
 */
async function classifierMarkers(
  db: D1Queryable,
  since: string,
  days: number,
): Promise<{ versions: ClassifierValueCount[]; daily: ClassifierDailyPoint[] }> {
  const result = await db
    .prepare(
      `SELECT substr(updated_at, 1, 10) AS day, meta_value AS value, COUNT(*) AS count
       FROM file_metadata
       WHERE meta_key = 'ai.classifier' AND ${aiRows("")}
       GROUP BY day, meta_value`,
    )
    .all<{ day: string; value: string; count: number }>();
  const totals = new Map<string, number>();
  const byDay = new Map<string, ClassifierDailyPoint>();
  const sinceDay = since.slice(0, 10);
  for (const row of result.results) {
    const n = Number(row.count);
    totals.set(row.value, (totals.get(row.value) ?? 0) + n);
    if (row.day < sinceDay) continue;
    const point = byDay.get(row.day) ?? zeroPoint(row.day);
    if (row.value === "skipped") point.skipped += n;
    else if (row.value === "failed") point.failed += n;
    else point.classified += n;
    byDay.set(row.day, point);
  }
  return {
    versions: [...totals].map(([value, count]) => ({ value, count })).sort(byCountDesc),
    daily: fillDaySeries(since, days, [...byDay.values()], zeroPoint),
  };
}

export async function buildClassifierOverview(
  db: D1Queryable,
  days: ClassifierAdminWindow,
  now = new Date(),
  costSeries: Promise<ClassifierCostSeries> = Promise.resolve({
    available: false,
    reason: "not_configured",
  }),
): Promise<ClassifierOverview> {
  const since = windowStart(days, now);
  const [labels, confidence, flaggedFiles, workspaces, markers, windowUploads, costs] =
    await Promise.all([
      labelCounts(db),
      flaggedConfidence(db),
      flaggedFileCount(db),
      workspaceCount(db),
      classifierMarkers(db, since, days),
      platformSeries(db, "upload", since)
        .then((rows) => rows.reduce((total, r) => total + Number(r.count), 0))
        .catch(() => null),
      costSeries,
    ]);
  const counts = (key: string) => labels.get(key) ?? [];
  const countOf = (value: string) => markers.versions.find((v) => v.value === value)?.count ?? 0;
  const skipped = countOf("skipped");
  const failed = countOf("failed");
  return {
    generatedAt: now.toISOString(),
    days,
    workspaces,
    versions: markers.versions,
    classified: sum(markers.versions) - skipped - failed,
    skipped,
    skipReasons: counts("ai.skip"),
    failed,
    errorReasons: counts("ai.error"),
    kinds: counts("ai.kind"),
    surfaces: counts("ai.surface"),
    screens: counts("ai.screen"),
    readiness: counts("ai.ready"),
    flags: CLASSIFIER_SAFETY_FIELDS.map((field) => {
      const values = counts(flagKey(field));
      return {
        field,
        answered: sum(values),
        flagged: sum(values.filter((v) => v.value !== CLASSIFIER_CLEAN_VALUES[field])),
        values,
        flaggedConfidence: confidence.get(flagKey(field)) ?? EMPTY_BUCKETS(),
      };
    }),
    flaggedFiles,
    daily: markers.daily,
    windowUploads,
    costs,
  };
}

export interface FlaggedCursor {
  at: string;
  workspace: string;
  key: string;
}

/** The shared `{ v: 1, u, ... }` cursor envelope (`pr-scope.ts`), plus the workspace. */
function encodeFlaggedCursor(cursor: FlaggedCursor): string {
  return encodeCursorEnvelope({ v: 1, u: cursor.at, w: cursor.workspace, k: cursor.key });
}

/** Throws a 400 `invalid_cursor` for anything that is not a flagged-list cursor. */
export function decodeFlaggedCursor(raw: string): FlaggedCursor {
  const record = parseCursorEnvelope(raw);
  if (typeof record.w !== "string" || typeof record.k !== "string" || !record.k) {
    throw invalidCursor();
  }
  return { at: record.u, workspace: record.w, key: record.k };
}

export interface FlaggedQuery {
  field?: ClassifierSafetyField;
  highConfidenceOnly?: boolean;
  workspace?: string;
  cursor?: FlaggedCursor;
  limit?: number;
}

const HYDRATE_KEYS = [
  "ai.classifier",
  "ai.kind",
  "ai.surface",
  "ai.screen",
  ...CLASSIFIER_SAFETY_FIELDS.flatMap((f) => [flagKey(f), confidenceKey(f)]),
];

export async function listFlaggedFiles(
  db: D1Queryable,
  query: FlaggedQuery,
): Promise<ClassifierFlaggedPage> {
  const limit = Math.min(
    Math.max(1, Math.floor(query.limit ?? CLASSIFIER_FLAGGED_DEFAULT_LIMIT)),
    CLASSIFIER_FLAGGED_MAX_LIMIT,
  );
  const flagged = flaggedWhere(query.field ? [query.field] : CLASSIFIER_SAFETY_FIELDS, "f.", {
    highOnly: query.highConfidenceOnly,
  });
  let where = `(${flagged.sql})`;
  const binds: unknown[] = [...flagged.binds];
  if (query.workspace) {
    where += " AND f.workspace = ?";
    binds.push(query.workspace);
  }
  // `at` is the newest flagged row per file, so the cursor compares after
  // the GROUP BY.
  let having = "";
  if (query.cursor) {
    const c = query.cursor;
    having = `HAVING at < ? OR (at = ? AND (f.workspace > ? OR (f.workspace = ? AND f.object_key > ?)))`;
    binds.push(c.at, c.at, c.workspace, c.workspace, c.key);
  }
  binds.push(limit + 1);

  const rows = await db
    .prepare(
      `SELECT f.workspace AS workspace, f.object_key AS object_key, MAX(f.updated_at) AS at
       FROM file_metadata f WHERE ${where}
       GROUP BY f.workspace, f.object_key ${having}
       ORDER BY at DESC, f.workspace ASC, f.object_key ASC LIMIT ?`,
    )
    .bind(...binds)
    .all<{ workspace: string; object_key: string; at: string }>();

  const page = rows.results.slice(0, limit);
  const last = page.at(-1);
  const nextCursor =
    rows.results.length > limit && last
      ? encodeFlaggedCursor({ at: last.at, workspace: last.workspace, key: last.object_key })
      : null;

  // One hydration per workspace on the page, in parallel.
  const keysByWorkspace = new Map<string, string[]>();
  for (const r of page) {
    keysByWorkspace.set(r.workspace, [...(keysByWorkspace.get(r.workspace) ?? []), r.object_key]);
  }
  const hydrated = new Map(
    await Promise.all(
      [...keysByWorkspace].map(
        async ([workspace, keys]) =>
          [
            workspace,
            await getMetadataForKeys(db, workspace, keys, { metaKeys: HYDRATE_KEYS }),
          ] as const,
      ),
    ),
  );

  const files: ClassifierFlaggedFile[] = page.map((r) => {
    const m = hydrated.get(r.workspace)?.get(r.object_key) ?? {};
    const flags = CLASSIFIER_SAFETY_FIELDS.flatMap((field) => {
      const value = m[flagKey(field)];
      if (value === undefined || value === CLASSIFIER_CLEAN_VALUES[field]) return [];
      const conf = m[confidenceKey(field)];
      return [{ field, value, confidence: isConfidenceBucket(conf) ? conf : null }];
    });
    return {
      workspace: r.workspace,
      key: r.object_key,
      flags,
      classifier: m["ai.classifier"] ?? null,
      kind: m["ai.kind"] ?? null,
      surface: m["ai.surface"] ?? null,
      screen: m["ai.screen"] ?? null,
      flaggedAt: r.at,
    };
  });
  return { files, nextCursor };
}
