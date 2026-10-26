/**
 * One-time, idempotent backfill: lowercases `file_metadata.meta_value` for the
 * keys in `LOWERCASED_META_KEYS` (today `gh.repo`) on rows written before
 * `canonicalMetaValue` existed. Mixed-case rows are invisible to the scope
 * queries and live links, which match the lowercase spelling exactly.
 *
 * Safe against the primary key: `file_metadata` is keyed by
 * `(workspace, object_key, meta_key)` and `meta_value` is in no unique index,
 * so changing a value can never collide with another row. `updated_at` is left
 * alone so listing order does not move. Mirrors self-serve-plan-backfill.ts:
 * admin-gated route, `dryRun`, a result object, hand-run once.
 *
 * Batches by `rowid` so no single D1 statement is large. Each call does at most
 * `maxBatches` batches; re-run until `remaining` is 0.
 */
import type { D1Queryable } from "./db-session";
import { LOWERCASED_META_KEYS, META_KEY_RE } from "./file-metadata";

export interface GhRepoCaseBackfillResult {
  dryRun: boolean;
  /** Rows needing the fix before this run. */
  affected: number;
  /** Rows rewritten by this run (0 in a dry run). */
  updated: number;
  batches: number;
  /** Rows still needing the fix after this run. */
  remaining: number;
}

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAX_BATCHES = 40;

/**
 * `meta_key IN ('gh.repo')` with the keys inlined as literals so SQLite can use
 * the partial `gh.repo` index. They are code constants; the regex guards a bad edit.
 */
function keyList(): string {
  for (const key of LOWERCASED_META_KEYS) {
    if (!META_KEY_RE.test(key)) throw new Error(`invalid lowercased meta key: ${key}`);
  }
  return LOWERCASED_META_KEYS.map((key) => `'${key}'`).join(", ");
}

async function countNeedingFix(db: D1Queryable): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM file_metadata
       WHERE meta_key IN (${keyList()}) AND meta_value <> lower(meta_value)`,
    )
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function backfillLowercasedMetaValues(
  db: D1Queryable,
  opts: { dryRun?: boolean; batchSize?: number; maxBatches?: number } = {},
): Promise<GhRepoCaseBackfillResult> {
  const dryRun = opts.dryRun === true;
  const batchSize = Math.max(1, Math.floor(opts.batchSize ?? DEFAULT_BATCH_SIZE));
  const maxBatches = Math.max(1, Math.floor(opts.maxBatches ?? DEFAULT_MAX_BATCHES));

  const affected = await countNeedingFix(db);
  if (dryRun || affected === 0) {
    return { dryRun, affected, updated: 0, batches: 0, remaining: affected };
  }

  const keys = keyList();
  let updated = 0;
  let batches = 0;
  while (batches < maxBatches) {
    const result = await db
      .prepare(
        `UPDATE file_metadata SET meta_value = lower(meta_value)
         WHERE rowid IN (
           SELECT rowid FROM file_metadata
           WHERE meta_key IN (${keys}) AND meta_value <> lower(meta_value)
           LIMIT ?
         )`,
      )
      .bind(batchSize)
      .run();
    const changed = result.meta?.changes ?? 0;
    if (changed === 0) break;
    updated += changed;
    batches += 1;
  }
  return { dryRun, affected, updated, batches, remaining: await countNeedingFix(db) };
}
