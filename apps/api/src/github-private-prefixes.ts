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

export function normalizeRepo(repo: string): string {
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

/** `gh/private/` is 11 chars; the 32-hex id occupies 12..43; the target segment starts at 44. */
const GH_PRIVATE_ROOT_LEN = "gh/private/".length;
const GH_PRIVATE_TARGET_OFFSET = GH_PRIVATE_ROOT_LEN + 32 + 1;

/**
 * The private prefix ids worth listing for one PR/issue target — the
 * O(1)-per-target replacement for `listActivePrefixIds` on the comment-sync
 * hot path (issue #934: that fan-out issued one R2 list per branch that ever
 * ran `put --pr`, and grew without bound).
 *
 * Union of three cheap D1 lookups, none of which is a trust decision — every
 * id returned here is still *listed* under the target's own key path, which
 * remains the boundary that decides what renders:
 *
 * 1. Ids parsed from this workspace's `file_metadata` keys shaped
 *    `gh/private/<id>/<kind>/<num>/…`. Every server and CLI writer of a
 *    private attachment stamps at least one metadata row, so this finds the
 *    prefix an attachment actually landed under, whichever branch minted it.
 * 2. The repo-level sentinel prefix (`branch = ""`), where issue attachments
 *    and branch-less uploads resolve. Covers a metadata-less raw PUT there.
 * 3. The PR head branch's prefix when the caller knows it (the webhook
 *    payload carries `head.ref`). Covers a metadata-less raw PUT on a PR.
 */
export async function listPrefixIdsForTarget(
  db: D1Queryable,
  workspace: string,
  repo: string,
  target: { kind: "pull" | "issues"; num: number },
  opts: { headBranch?: string } = {},
): Promise<string[]> {
  const segment = `/${target.kind}/${target.num}/`;
  const { results } = await db
    .prepare(
      // Key-range on the PK (workspace, object_key) rather than LIKE/GLOB: D1
      // caps pattern length (see file-metadata.ts PREFIX_FILTER_SQL), and a
      // range scan is cheaper than a pattern over the workspace's rows.
      `SELECT DISTINCT substr(object_key, ?, 32) AS prefix_id FROM file_metadata
       WHERE workspace = ?
         AND object_key >= 'gh/private/' AND object_key < 'gh/private0'
         AND substr(object_key, ?, ?) = ?`,
    )
    .bind(GH_PRIVATE_ROOT_LEN + 1, workspace, GH_PRIVATE_TARGET_OFFSET, segment.length, segment)
    .all<PrefixRow>();
  const discovered = (results ?? [])
    .map((row) => row.prefix_id)
    .filter((id) => PRIVATE_PREFIX_ID_RE.test(id));

  // Private keys omit the repo, so a workspace bound to two private repos
  // with the same PR/issue number would otherwise surface repo A's prefix
  // for repo B's comment. Keep only ids this repo minted (rotated or not:
  // ownership is what matters, and rotation re-keys objects anyway).
  const ids = new Set<string>();
  if (discovered.length > 0) {
    const placeholders = discovered.map(() => "?").join(", ");
    const owned = await db
      .prepare(
        `SELECT prefix_id FROM github_private_prefixes
         WHERE repo_full_name = ? AND prefix_id IN (${placeholders})`,
      )
      .bind(normalizeRepo(repo), ...discovered)
      .all<PrefixRow>();
    for (const row of owned.results ?? []) ids.add(row.prefix_id);
  }

  const sentinel = await getActivePrefixId(db, repo, "");
  if (sentinel) ids.add(sentinel);
  if (opts.headBranch !== undefined && opts.headBranch !== "") {
    const head = await getActivePrefixId(db, repo, opts.headBranch);
    if (head) ids.add(head);
  }
  return [...ids].sort();
}

/**
 * All active (non-retired) prefix ids for `repo`, across every branch.
 * Grows with every branch that ever ran `put --pr`; not for per-target hot
 * paths — use `listPrefixIdsForTarget` there (#934).
 */
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

interface PrefixRepoRow {
  repo_full_name: string;
}

/**
 * The repo that minted `prefixId`, or null if the id is unknown.
 *
 * A private-repo key (`gh/private/<id>/…`) deliberately omits the repo, and
 * the object's `gh.repo` metadata is CLIENT-SETTABLE — so this row, minted
 * server-side for exactly one repo, is the only authoritative answer for
 * "which repo does this private attachment belong to?" (issue #934's
 * attachment index derives every row's `repo` from here).
 *
 * Rotated (tombstoned) ids resolve too: ownership is what matters, not
 * whether the id is still active.
 */
export async function repoForPrefixId(db: D1Queryable, prefixId: string): Promise<string | null> {
  if (!PRIVATE_PREFIX_ID_RE.test(prefixId)) return null;
  const row = await db
    .prepare(`SELECT repo_full_name FROM github_private_prefixes WHERE prefix_id = ? LIMIT 1`)
    .bind(prefixId)
    .first<PrefixRepoRow>();
  return row ? row.repo_full_name : null;
}
