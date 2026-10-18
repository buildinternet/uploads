/**
 * Read side of the operator classifier views. Pure `(db, ...)` helpers over
 * `file_metadata` (EAV, one row per key), no Hono dependency.
 *
 * D1 bills rows read, so every query binds `meta_key` (or an `IN` list of
 * literal keys) first and repeats `AI_ROWS`, the partial-index predicate of
 * `file_metadata_ai_idx`. Without that literal term SQLite will not use the
 * index and every read scans the table. The overview is cached in KV by
 * the route.
 */

import { windowStart, platformSeries } from "./adoption-queries";
import {
  CLASSIFIER_CLEAN_VALUES,
  type ClassifierAdminWindow,
  type ClassifierConfidenceBucket,
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

export const CLASSIFIER_CACHE_TTL = 600;
export const CLASSIFIER_FLAGGED_DEFAULT_LIMIT = 50;
export const CLASSIFIER_FLAGGED_MAX_LIMIT = 200;

export const CLASSIFIER_SAFETY_FIELDS: readonly ClassifierSafetyField[] = [
  "rating",
  "content",
  "secret",
  "pii",
];
const BUCKETS: readonly ClassifierConfidenceBucket[] = ["high", "medium", "low"];

export function classifierCacheKey(days: number): string {
  return `metrics:classifier:v1:${days}`;
}

/** Must match the `WHERE` of `file_metadata_ai_idx` exactly. */
const AI_ROWS = "substr(meta_key, 1, 3) = 'ai.'";
const aiRows = (alias: string) => `substr(${alias}.meta_key, 1, 3) = 'ai.'`;

const flagKey = (field: ClassifierSafetyField) => `ai.${field}`;
const confidenceKey = (field: ClassifierSafetyField) => `ai.${field}.confidence`;

async function valueCounts(db: D1Queryable, metaKey: string): Promise<ClassifierValueCount[]> {
  const result = await db
    .prepare(
      `SELECT meta_value AS value, COUNT(*) AS count FROM file_metadata
       WHERE meta_key = ? AND ${AI_ROWS} GROUP BY meta_value ORDER BY count DESC, value`,
    )
    .bind(metaKey)
    .all<ClassifierValueCount>();
  return result.results.map((r) => ({ value: r.value, count: Number(r.count) }));
}

async function flagStats(
  db: D1Queryable,
  field: ClassifierSafetyField,
): Promise<ClassifierFlagStats> {
  const clean = CLASSIFIER_CLEAN_VALUES[field];
  const [values, conf] = await Promise.all([
    valueCounts(db, flagKey(field)),
    db
      .prepare(
        `SELECT c.meta_value AS bucket, COUNT(*) AS count
         FROM file_metadata f
         JOIN file_metadata c ON c.workspace = f.workspace AND c.object_key = f.object_key
           AND c.meta_key = ?
         WHERE f.meta_key = ? AND ${aiRows("f")} AND f.meta_value <> ?
         GROUP BY c.meta_value`,
      )
      .bind(confidenceKey(field), flagKey(field), clean)
      .all<{ bucket: string; count: number }>(),
  ]);
  const flaggedConfidence = { high: 0, medium: 0, low: 0 };
  for (const row of conf.results) {
    if ((BUCKETS as readonly string[]).includes(row.bucket)) {
      flaggedConfidence[row.bucket as ClassifierConfidenceBucket] = Number(row.count);
    }
  }
  return {
    field,
    answered: values.reduce((sum, v) => sum + v.count, 0),
    flagged: values.filter((v) => v.value !== clean).reduce((sum, v) => sum + v.count, 0),
    values,
    flaggedConfidence,
  };
}

/** SQL predicate (with binds) matching a stored non-clean safety answer. */
function flaggedPredicate(fields: readonly ClassifierSafetyField[]): {
  sql: string;
  binds: string[];
} {
  return {
    sql: fields.map(() => "(meta_key = ? AND meta_value <> ?)").join(" OR "),
    binds: fields.flatMap((f) => [flagKey(f), CLASSIFIER_CLEAN_VALUES[f]]),
  };
}

async function flaggedFileCount(db: D1Queryable): Promise<number> {
  const { sql, binds } = flaggedPredicate(CLASSIFIER_SAFETY_FIELDS);
  const row = await db
    .prepare(
      `SELECT COUNT(DISTINCT workspace || char(31) || object_key) AS n FROM file_metadata
       WHERE meta_key IN (${CLASSIFIER_SAFETY_FIELDS.map(() => "?").join(", ")}) AND ${AI_ROWS}
         AND (${sql})`,
    )
    .bind(...CLASSIFIER_SAFETY_FIELDS.map(flagKey), ...binds)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function dailySeries(db: D1Queryable, since: string, days: number) {
  const result = await db
    .prepare(
      `SELECT substr(updated_at, 1, 10) AS day, meta_value AS value, COUNT(*) AS count
       FROM file_metadata
       WHERE meta_key = 'ai.classifier' AND ${AI_ROWS} AND updated_at >= ?
       GROUP BY day, meta_value`,
    )
    .bind(since)
    .all<{ day: string; value: string; count: number }>();
  const byDay = new Map<
    string,
    { day: string; classified: number; skipped: number; failed: number }
  >();
  for (const row of result.results) {
    const point = byDay.get(row.day) ?? { day: row.day, classified: 0, skipped: 0, failed: 0 };
    const n = Number(row.count);
    if (row.value === "skipped") point.skipped += n;
    else if (row.value === "failed") point.failed += n;
    else point.classified += n;
    byDay.set(row.day, point);
  }
  return fillDaySeries(since, days, [...byDay.values()], (day) => ({
    day,
    classified: 0,
    skipped: 0,
    failed: 0,
  }));
}

export async function buildClassifierOverview(
  db: D1Queryable,
  days: ClassifierAdminWindow,
  now = new Date(),
): Promise<ClassifierOverview> {
  const since = windowStart(days, now);
  const [
    versions,
    skipReasons,
    errorReasons,
    kinds,
    surfaces,
    screens,
    flags,
    flaggedFiles,
    ws,
    daily,
    windowUploads,
  ] = await Promise.all([
    valueCounts(db, "ai.classifier"),
    valueCounts(db, "ai.skip"),
    valueCounts(db, "ai.error"),
    valueCounts(db, "ai.kind"),
    valueCounts(db, "ai.surface"),
    valueCounts(db, "ai.screen"),
    Promise.all(CLASSIFIER_SAFETY_FIELDS.map((f) => flagStats(db, f))),
    flaggedFileCount(db),
    db
      .prepare(
        `SELECT COUNT(DISTINCT workspace) AS n FROM file_metadata
         WHERE meta_key = 'ai.classifier' AND ${AI_ROWS}`,
      )
      .first<{ n: number }>(),
    dailySeries(db, since, days),
    platformSeries(db, "upload", since)
      .then((rows) => rows.reduce((sum, r) => sum + Number(r.count), 0))
      .catch(() => null),
  ]);
  const countOf = (value: string) => versions.find((v) => v.value === value)?.count ?? 0;
  const skipped = countOf("skipped");
  const failed = countOf("failed");
  const total = versions.reduce((sum, v) => sum + v.count, 0);
  return {
    generatedAt: now.toISOString(),
    days,
    workspaces: Number(ws?.n ?? 0),
    versions,
    classified: total - skipped - failed,
    skipped,
    skipReasons,
    failed,
    errorReasons,
    kinds,
    surfaces,
    screens,
    flags,
    flaggedFiles,
    daily,
    windowUploads,
  };
}

export interface FlaggedQuery {
  field?: ClassifierSafetyField;
  highConfidenceOnly?: boolean;
  workspace?: string;
  cursor?: string | null;
  limit?: number;
}

interface Cursor {
  at: string;
  workspace: string;
  key: string;
}

export function encodeFlaggedCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

/** Returns null for anything that is not a well-formed cursor. */
export function decodeFlaggedCursor(raw: string): Cursor | null {
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<Cursor>;
    if (
      v &&
      typeof v.at === "string" &&
      typeof v.workspace === "string" &&
      typeof v.key === "string"
    ) {
      return { at: v.at, workspace: v.workspace, key: v.key };
    }
  } catch {
    // fall through
  }
  return null;
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
  const fields = query.field ? [query.field] : CLASSIFIER_SAFETY_FIELDS;
  const binds: unknown[] = [];

  // One leg per field; with confidence=high the leg also requires the
  // field's own `.confidence` row to be high.
  const legs = fields.map((f) => {
    binds.push(flagKey(f), CLASSIFIER_CLEAN_VALUES[f]);
    let leg = "(f.meta_key = ? AND f.meta_value <> ?";
    if (query.highConfidenceOnly) {
      leg += ` AND EXISTS (SELECT 1 FROM file_metadata c WHERE c.workspace = f.workspace
        AND c.object_key = f.object_key AND c.meta_key = ? AND c.meta_value = 'high')`;
      binds.push(confidenceKey(f));
    }
    return `${leg})`;
  });
  const keyList = fields.map(() => "?").join(", ");
  // meta_key IN (...) first so the planner seeks by key.
  const keyBinds = fields.map(flagKey);

  let where = `f.meta_key IN (${keyList}) AND ${aiRows("f")} AND (${legs.join(" OR ")})`;
  const allBinds: unknown[] = [...keyBinds, ...binds];
  if (query.workspace) {
    where += " AND f.workspace = ?";
    allBinds.push(query.workspace);
  }
  let having = "";
  if (query.cursor) {
    const c = decodeFlaggedCursor(query.cursor);
    if (!c) throw new Error("invalid cursor");
    having = `HAVING at < ? OR (at = ? AND (f.workspace > ? OR (f.workspace = ? AND f.object_key > ?)))`;
    allBinds.push(c.at, c.at, c.workspace, c.workspace, c.key);
  }
  allBinds.push(limit + 1);

  const rows = await db
    .prepare(
      `SELECT f.workspace AS workspace, f.object_key AS object_key, MAX(f.updated_at) AS at
       FROM file_metadata f WHERE ${where}
       GROUP BY f.workspace, f.object_key ${having}
       ORDER BY at DESC, f.workspace ASC, f.object_key ASC LIMIT ?`,
    )
    .bind(...allBinds)
    .all<{ workspace: string; object_key: string; at: string }>();

  const page = rows.results.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.results.length > limit && last
      ? encodeFlaggedCursor({ at: last.at, workspace: last.workspace, key: last.object_key })
      : null;

  const byWorkspace = new Map<string, string[]>();
  for (const r of page) {
    const list = byWorkspace.get(r.workspace) ?? [];
    list.push(r.object_key);
    byWorkspace.set(r.workspace, list);
  }
  const meta = new Map<string, Map<string, Record<string, string>>>();
  for (const [workspace, keys] of byWorkspace) {
    meta.set(workspace, await getMetadataForKeys(db, workspace, keys, { metaKeys: HYDRATE_KEYS }));
  }

  const files: ClassifierFlaggedFile[] = page.map((r) => {
    const m = meta.get(r.workspace)?.get(r.object_key) ?? {};
    const flags = CLASSIFIER_SAFETY_FIELDS.flatMap((field) => {
      const value = m[flagKey(field)];
      if (value === undefined || value === CLASSIFIER_CLEAN_VALUES[field]) return [];
      const conf = m[confidenceKey(field)];
      return [
        {
          field,
          value,
          confidence: (BUCKETS as readonly string[]).includes(conf ?? "")
            ? (conf as ClassifierConfidenceBucket)
            : null,
        },
      ];
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
