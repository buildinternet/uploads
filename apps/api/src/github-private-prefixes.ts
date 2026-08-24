/**
 * Randomized per-branch URL prefixes for private-repo attachments (#631,
 * `github_private_prefixes` D1 table). One active id per (repo, branch);
 * `branch = ""` is the repo-level sentinel (issue attachments, ingestion).
 * Rotated rows are kept as tombstones (`rotated_at` set) rather than
 * deleted, so a retired prefix id can still be recognized as "was once
 * valid" by later tasks if needed.
 *
 * The active-row invariant (at most one un-rotated row per (repo, branch))
 * is enforced by the DB itself via the partial unique index
 * `github_private_prefixes_active_idx` (see the migration), not by
 * application logic — `getOrMintPrefixId` is race-safe because of that
 * index, not despite the lack of one.
 */
import { type D1Queryable } from "./db-session";

interface PrefixRow {
  prefix_id: string;
}

function normalizeRepo(repo: string): string {
  return repo.toLowerCase();
}

function normalizeBranch(branch: string): string {
  return branch.toLowerCase();
}

/** 16 random bytes as 32 lowercase hex chars — the id embedded in a private attachment URL. */
export function generatePrefixId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Matches exactly what `generatePrefixId` produces: 32 lowercase hex chars. */
export const PRIVATE_PREFIX_ID_RE = /^[0-9a-f]{32}$/;

/** The currently active prefix id for (repo, branch), or null if none has been minted. */
export async function getActivePrefixId(
  db: D1Queryable,
  repo: string,
  branch: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT prefix_id FROM github_private_prefixes
       WHERE repo_full_name = ? AND branch = ? AND rotated_at IS NULL`,
    )
    .bind(normalizeRepo(repo), normalizeBranch(branch))
    .first<PrefixRow>();
  return row ? row.prefix_id : null;
}

/**
 * Returns the active prefix id for (repo, branch), minting one if none
 * exists yet. Read-first: the steady state (an id already minted) costs one
 * query. Race-safe on the mint path: concurrent first-callers all
 * `INSERT OR IGNORE` against the partial unique index, so at most one insert
 * wins; every caller (winner and losers) then re-selects the active row, so
 * they all converge on the same id regardless of who won.
 */
export async function getOrMintPrefixId(
  db: D1Queryable,
  repo: string,
  branch: string,
  now = new Date(),
): Promise<string> {
  const normalizedRepo = normalizeRepo(repo);
  const normalizedBranch = normalizeBranch(branch);

  const existing = await getActivePrefixId(db, normalizedRepo, normalizedBranch);
  if (existing !== null) return existing;

  const candidate = generatePrefixId();

  await db
    .prepare(
      `INSERT OR IGNORE INTO github_private_prefixes
         (repo_full_name, branch, prefix_id, created_at, rotated_at)
       VALUES (?, ?, ?, ?, NULL)`,
    )
    .bind(normalizedRepo, normalizedBranch, candidate, now.toISOString())
    .run();

  const active = await getActivePrefixId(db, normalizedRepo, normalizedBranch);
  if (active === null) {
    // The partial unique index only blocks a second *active* row; it
    // can't fire here because we just inserted (or IGNOREd into) one — a
    // null result would mean the insert genuinely failed to land, which
    // should never happen for a fresh D1 write.
    throw new Error(`getOrMintPrefixId: no active row after insert for ${normalizedRepo}`);
  }
  return active;
}

/** All active (non-retired) prefix ids for `repo`, across every branch. */
export async function listActivePrefixIds(db: D1Queryable, repo: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT prefix_id FROM github_private_prefixes
       WHERE repo_full_name = ? AND rotated_at IS NULL`,
    )
    .bind(normalizeRepo(repo))
    .all<PrefixRow>();
  return (results ?? []).map((row) => row.prefix_id);
}

/**
 * All RETIRED prefix ids for (repo, branch), oldest first. Rotation's
 * resumability (issue #631, Task 8) uses this to drain any leftovers
 * stranded under a PREVIOUS rotation that was interrupted mid-sweep — a
 * plain re-run of rotation only sweeps the id it itself just retired, so
 * without this an earlier crash's abandoned objects would sit under a
 * tombstoned id forever, unreachable at the (repo, branch)'s current active
 * id and never revoked. Distinct from `listActivePrefixIds`, which is
 * scoped to non-retired rows across an entire repo, not one branch.
 */
export async function listRetiredPrefixIds(
  db: D1Queryable,
  repo: string,
  branch: string,
): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT prefix_id FROM github_private_prefixes
       WHERE repo_full_name = ? AND branch = ? AND rotated_at IS NOT NULL
       ORDER BY created_at ASC`,
    )
    .bind(normalizeRepo(repo), normalizeBranch(branch))
    .all<PrefixRow>();
  return (results ?? []).map((row) => row.prefix_id);
}

/**
 * Retires an active prefix id, stamping `rotated_at`. The row is kept as a
 * tombstone rather than deleted. A subsequent `getOrMintPrefixId` for the
 * same (repo, branch) mints a fresh id, since the partial unique index no
 * longer sees an active row.
 */
export async function retirePrefixId(
  db: D1Queryable,
  repo: string,
  branch: string,
  prefixId: string,
  now = new Date(),
): Promise<void> {
  await db
    .prepare(
      `UPDATE github_private_prefixes SET rotated_at = ?
       WHERE repo_full_name = ? AND branch = ? AND prefix_id = ? AND rotated_at IS NULL`,
    )
    .bind(now.toISOString(), normalizeRepo(repo), normalizeBranch(branch), prefixId)
    .run();
}
