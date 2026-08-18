/**
 * Ledger of link-adopted files (`github_adopted_links` D1 table), the
 * idempotency backbone for `github-link-adopt.ts`'s noise guard — mirrors
 * `github-ingest-ledger.ts`'s pattern exactly, scoped by
 * (repo, kind, num, sourceKey) instead of (repo, assetId) since a link
 * adoption is inherently per-PR/issue (the same source object can be
 * independently adopted into more than one target). One row per resolved
 * source key; `detachedAt` NULL means the copy is currently referenced by
 * `source` (the body or the specific comment it was last seen pasted in).
 * When a rescan no longer finds the source key referenced from that exact
 * source, the caller sets `detachedAt`; if it later reappears, `detachedAt`
 * is cleared back to null rather than inserting a duplicate row — the copy
 * itself is never deleted (issue #709: "deleting the copied object is NOT
 * required — detach means removed from the managed comment").
 *
 * Called from inside the webhook queue consumer, where a D1 failure must
 * surface as a thrown error so the queue retries the delivery — nothing here
 * swallows errors, same doctrine as the ingest ledger.
 */

export interface AdoptLedgerRow {
  repo: string; // lowercase owner/name
  kind: "pull" | "issues";
  num: number;
  sourceKey: string; // the resolved workspace key the pasted URL pointed to
  workspace: string;
  objectKey: string; // the adopted copy's key under the target's gh prefix
  source: string; // "body" | "comment:<id>"
  createdAt: string; // ISO
  detachedAt: string | null;
}

interface AdoptLedgerDbRow {
  repo: string;
  kind: "pull" | "issues";
  num: number;
  source_key: string;
  workspace: string;
  object_key: string;
  source: string;
  created_at: string;
  detached_at: string | null;
}

function normalizeRepo(repo: string): string {
  return repo.toLowerCase();
}

function fromRow(row: AdoptLedgerDbRow): AdoptLedgerRow {
  return {
    repo: row.repo,
    kind: row.kind,
    num: row.num,
    sourceKey: row.source_key,
    workspace: row.workspace,
    objectKey: row.object_key,
    source: row.source,
    createdAt: row.created_at,
    detachedAt: row.detached_at,
  };
}

const SELECT_COLUMNS =
  "repo, kind, num, source_key, workspace, object_key, source, created_at, detached_at";

/**
 * Records a newly-adopted link. `INSERT OR IGNORE` on the
 * (repo, kind, num, source_key) primary key: a duplicate record (the same
 * source key re-scanned before its row is read) is a silent no-op rather
 * than an overwrite — `setLedgerDetached`/`setLedgerSource` are the explicit
 * ways to update an existing row.
 */
export async function recordAdoptedLink(
  db: D1Database,
  row: Omit<AdoptLedgerRow, "detachedAt">,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO github_adopted_links
         (repo, kind, num, source_key, workspace, object_key, source, created_at, detached_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      normalizeRepo(row.repo),
      row.kind,
      row.num,
      row.sourceKey,
      row.workspace,
      row.objectKey,
      row.source,
      row.createdAt,
    )
    .run();
}

/** The ledger row for a single (repo, kind, num, source key), or null if never recorded. */
export async function adoptLedgerRow(
  db: D1Database,
  repo: string,
  kind: "pull" | "issues",
  num: number,
  sourceKey: string,
): Promise<AdoptLedgerRow | null> {
  const row = await db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM github_adopted_links
       WHERE repo = ? AND kind = ? AND num = ? AND source_key = ?`,
    )
    .bind(normalizeRepo(repo), kind, num, sourceKey)
    .first<AdoptLedgerDbRow>();
  return row ? fromRow(row) : null;
}

/** All ledger rows for (repo, kind, num) currently attributed to `source` ("body" or "comment:<id>"). */
export async function adoptLedgerRowsForSource(
  db: D1Database,
  repo: string,
  kind: "pull" | "issues",
  num: number,
  source: string,
): Promise<AdoptLedgerRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM github_adopted_links
       WHERE repo = ? AND kind = ? AND num = ? AND source = ?`,
    )
    .bind(normalizeRepo(repo), kind, num, source)
    .all<AdoptLedgerDbRow>();
  return (results ?? []).map(fromRow);
}

/** Every ledger row for (repo, kind, num), across every source — the basis
 * for the noise guard's total-adopted count (detached rows excluded by the
 * caller, same as ingest's own target-scoped reads). */
export async function adoptLedgerRowsForTarget(
  db: D1Database,
  repo: string,
  kind: "pull" | "issues",
  num: number,
): Promise<AdoptLedgerRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM github_adopted_links WHERE repo = ? AND kind = ? AND num = ?`,
    )
    .bind(normalizeRepo(repo), kind, num)
    .all<AdoptLedgerDbRow>();
  return (results ?? []).map(fromRow);
}

/**
 * Flips `detachedAt` for a ledger row — set to a timestamp when a rescan no
 * longer finds the source key referenced, or back to null when it
 * reappears.
 */
export async function setAdoptLedgerDetached(
  db: D1Database,
  repo: string,
  kind: "pull" | "issues",
  num: number,
  sourceKey: string,
  detachedAt: string | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE github_adopted_links SET detached_at = ?
       WHERE repo = ? AND kind = ? AND num = ? AND source_key = ?`,
    )
    .bind(detachedAt, normalizeRepo(repo), kind, num, sourceKey)
    .run();
}

/**
 * Moves an already-recorded link between sources (e.g. a comment gets
 * edited and the link now lives under a different comment id, or moves from
 * a comment into the body).
 */
export async function setAdoptLedgerSource(
  db: D1Database,
  repo: string,
  kind: "pull" | "issues",
  num: number,
  sourceKey: string,
  source: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE github_adopted_links SET source = ?
       WHERE repo = ? AND kind = ? AND num = ? AND source_key = ?`,
    )
    .bind(source, normalizeRepo(repo), kind, num, sourceKey)
    .run();
}
