/**
 * Ledger of GitHub-native user-attachments mirrored into workspaces
 * (`github_ingested_assets` D1 table), the idempotency backbone for the
 * ingest reconcile loop (see docs/superpowers/specs/2026-08-11-github-
 * attachment-ingestion-design.md). One row per (repo, asset id);
 * `detachedAt` NULL means the asset is currently referenced by `source` in
 * the PR/issue body or comment it was recorded against. When a subsequent
 * scan no longer finds the asset referenced, the reconciler sets
 * `detachedAt`; if it later reappears, `detachedAt` is cleared back to null
 * rather than inserting a duplicate row.
 *
 * This module is called from inside the queue consumer, where a D1 failure
 * must surface as a thrown error so the queue retries the delivery — unlike
 * github-repo-links.ts's `findRepoLink`/`recordRepoLink`, nothing here
 * swallows errors.
 */

export interface IngestLedgerRow {
  repo: string; // lowercase owner/name
  assetId: string; // path after /user-attachments/, e.g. "assets/<uuid>" or "files/123/shot.png"
  workspace: string;
  objectKey: string;
  kind: "pull" | "issues";
  num: number;
  source: string; // "body" | "comment:<id>"
  createdAt: string; // ISO
  detachedAt: string | null;
}

interface IngestLedgerDbRow {
  repo: string;
  asset_id: string;
  workspace: string;
  object_key: string;
  kind: "pull" | "issues";
  num: number;
  source: string;
  created_at: string;
  detached_at: string | null;
}

function normalizeRepo(repo: string): string {
  return repo.toLowerCase();
}

function fromRow(row: IngestLedgerDbRow): IngestLedgerRow {
  return {
    repo: row.repo,
    assetId: row.asset_id,
    workspace: row.workspace,
    objectKey: row.object_key,
    kind: row.kind,
    num: row.num,
    source: row.source,
    createdAt: row.created_at,
    detachedAt: row.detached_at,
  };
}

/**
 * Records a newly-discovered ingested asset. `INSERT OR IGNORE` on the
 * (repo, asset_id) primary key: a duplicate record (the same asset seen
 * again on a later scan) is a silent no-op rather than an overwrite —
 * `setLedgerDetached`/`setLedgerSource` are the explicit ways to update an
 * existing row.
 */
export async function recordIngestedAsset(
  db: D1Database,
  row: Omit<IngestLedgerRow, "detachedAt">,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO github_ingested_assets
         (repo, asset_id, workspace, object_key, kind, num, source, created_at, detached_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      normalizeRepo(row.repo),
      row.assetId,
      row.workspace,
      row.objectKey,
      row.kind,
      row.num,
      row.source,
      row.createdAt,
    )
    .run();
}

/** The ledger row for a single (repo, asset id), or null if never recorded. */
export async function ledgerRow(
  db: D1Database,
  repo: string,
  assetId: string,
): Promise<IngestLedgerRow | null> {
  const row = await db
    .prepare(
      `SELECT repo, asset_id, workspace, object_key, kind, num, source, created_at, detached_at
       FROM github_ingested_assets WHERE repo = ? AND asset_id = ?`,
    )
    .bind(normalizeRepo(repo), assetId)
    .first<IngestLedgerDbRow>();
  return row ? fromRow(row) : null;
}

/** All ledger rows for `repo` currently attributed to `source` ("body" or "comment:<id>"). */
export async function ledgerRowsForSource(
  db: D1Database,
  repo: string,
  source: string,
): Promise<IngestLedgerRow[]> {
  const { results } = await db
    .prepare(
      `SELECT repo, asset_id, workspace, object_key, kind, num, source, created_at, detached_at
       FROM github_ingested_assets WHERE repo = ? AND source = ?`,
    )
    .bind(normalizeRepo(repo), source)
    .all<IngestLedgerDbRow>();
  return (results ?? []).map(fromRow);
}

/** All ledger rows for `repo` currently attributed to `kind`/`num` (across every source). */
export async function ledgerRowsForTarget(
  db: D1Database,
  repo: string,
  kind: "pull" | "issues",
  num: number,
): Promise<IngestLedgerRow[]> {
  const { results } = await db
    .prepare(
      `SELECT repo, asset_id, workspace, object_key, kind, num, source, created_at, detached_at
       FROM github_ingested_assets WHERE repo = ? AND kind = ? AND num = ?`,
    )
    .bind(normalizeRepo(repo), kind, num)
    .all<IngestLedgerDbRow>();
  return (results ?? []).map(fromRow);
}

/**
 * Flips `detachedAt` for a ledger row — set to a timestamp when the
 * reconciler no longer finds the asset referenced, or back to null when it
 * reappears.
 */
export async function setLedgerDetached(
  db: D1Database,
  repo: string,
  assetId: string,
  detachedAt: string | null,
): Promise<void> {
  await db
    .prepare(`UPDATE github_ingested_assets SET detached_at = ? WHERE repo = ? AND asset_id = ?`)
    .bind(detachedAt, normalizeRepo(repo), assetId)
    .run();
}

/**
 * Moves an already-recorded asset between sources (e.g. a comment gets
 * edited and the asset now lives under a different comment id, or moves
 * from a comment into the body).
 */
export async function setLedgerSource(
  db: D1Database,
  repo: string,
  assetId: string,
  source: string,
): Promise<void> {
  await db
    .prepare(`UPDATE github_ingested_assets SET source = ? WHERE repo = ? AND asset_id = ?`)
    .bind(source, normalizeRepo(repo), assetId)
    .run();
}
