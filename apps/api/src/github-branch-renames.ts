/**
 * Branch-rename aliases for staged GitHub attachments (#920,
 * `github_branch_renames` D1 table). `git branch -m old new` strands
 * everything staged under the old branch's prefix; the CLI reads the new
 * branch's reflog and registers each `(old -> new)` pair here, and promote
 * sweeps the branch's whole name lineage instead of just its current name.
 *
 * Rows are scoped by workspace on purpose: a rename only ever widens which
 * of the CALLING workspace's own staged prefixes a promote sweeps, so one
 * workspace's rows can never influence another's promote. `source` records
 * where the pair came from (`cli-reflog` today) so a later webhook-driven
 * detector can be added without a schema change.
 *
 * Case handling: both branch columns are `COLLATE NOCASE`, so the table
 * itself dedupes case variants, and the walk below dedupes case-insensitively
 * to match. Names are still STORED verbatim — plain staged prefixes are
 * case-preserving, so the lineage has to hand promote the exact spelling it
 * was staged under.
 *
 * Env-free (`D1Queryable` only) so the request/response types below can be
 * imported by other apps via `@uploads/api/github-branch-renames` — see
 * AGENTS.md § Conventions, "Wire types".
 */
import { ValidationError } from "@uploads/errors";
import { type D1Queryable } from "./db-session";

/** `POST /v1/workspaces/:workspace/github/branch-rename` request body. */
export interface BranchRenameRequest {
  /** "owner/name". */
  repo: string;
  /** The branch's previous name. */
  from: string;
  /** The branch's current name. */
  to: string;
}

/** `POST /v1/workspaces/:workspace/github/branch-rename` response. */
export interface BranchRenameResponse {
  /** False when this exact pair was already on file (`INSERT OR IGNORE` no-op). */
  recorded: boolean;
}

export interface RecordBranchRenameInput extends BranchRenameRequest {
  workspace: string;
  /** Provenance of the pair: `cli-reflog` today, `webhook-push` reserved. */
  source: string;
  now?: Date;
}

/**
 * Max hops walked backwards from the queried branch. Eight chained renames
 * on one unmerged branch is already well past anything real; the cap keeps a
 * pathological (or adversarially seeded) alias graph from turning one
 * promote into an unbounded fan of D1 reads and R2 lists.
 */
const LINEAGE_DEPTH_CAP = 8;

/**
 * Max names returned, INCLUDING the queried branch. Bounds the fan-in case
 * (many old names all renamed to the same new one), which depth alone
 * doesn't — every extra name costs promote an R2 list (two in private mode).
 */
const LINEAGE_TOTAL_CAP = 16;

interface OldBranchRow {
  old_branch: string;
}

function normalizeRepo(repo: string): string {
  return repo.toLowerCase();
}

/**
 * Records one `(from -> to)` rename for this workspace's repo.
 * `INSERT OR IGNORE`, so re-registering the same pair (the CLI replays the
 * whole reflog on every run) is a cheap no-op reported as `recorded: false`.
 */
export async function recordBranchRename(
  db: D1Queryable,
  input: RecordBranchRenameInput,
): Promise<BranchRenameResponse> {
  const { workspace, repo, from, to, source, now = new Date() } = input;
  if (from.toLowerCase() === to.toLowerCase()) {
    // The table's NOCASE key would happily store this as a self-loop; the
    // walk is cycle-safe either way, but a self-rename is meaningless input.
    throw new ValidationError("from and to must be different branches.", {
      code: "same_branch",
    });
  }

  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO github_branch_renames
         (workspace, repo_full_name, old_branch, new_branch, source, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(workspace, normalizeRepo(repo), from, to, source, now.toISOString())
    .run();

  return { recorded: (result.meta?.changes ?? 0) > 0 };
}

/**
 * `[branch, ...older names]` — the branch's rename lineage, newest first.
 * Breadth-first over `new_branch -> old_branch`, so nearer ancestors come
 * before more distant ones and promote's "first match wins" dedupe resolves
 * to the current name. Cycle-safe and case-insensitively deduped; bounded by
 * `LINEAGE_DEPTH_CAP` hops and `LINEAGE_TOTAL_CAP` names. `[branch]` when
 * nothing is on file.
 */
export async function resolveBranchLineage(
  db: D1Queryable,
  workspace: string,
  repo: string,
  branch: string,
): Promise<string[]> {
  const repoFullName = normalizeRepo(repo);
  const lineage = [branch];
  const seen = new Set([branch.toLowerCase()]);
  let frontier = [branch];

  for (let depth = 0; depth < LINEAGE_DEPTH_CAP; depth++) {
    if (frontier.length === 0 || lineage.length >= LINEAGE_TOTAL_CAP) break;
    const next: string[] = [];
    for (const name of frontier) {
      const { results } = await db
        .prepare(
          `SELECT old_branch FROM github_branch_renames
           WHERE workspace = ? AND repo_full_name = ? AND new_branch = ?
           ORDER BY recorded_at ASC`,
        )
        .bind(workspace, repoFullName, name)
        .all<OldBranchRow>();
      for (const row of results ?? []) {
        const lower = row.old_branch.toLowerCase();
        if (seen.has(lower)) continue;
        seen.add(lower);
        lineage.push(row.old_branch);
        next.push(row.old_branch);
        if (lineage.length >= LINEAGE_TOTAL_CAP) return lineage;
      }
    }
    frontier = next;
  }

  return lineage;
}

/**
 * Fail-open wrapper for promote: a lineage lookup is an enhancement, never a
 * reason for a promote to fail. Any error logs and degrades to `[branch]` —
 * exactly the pre-#920 behavior.
 */
export async function resolveBranchLineageSafe(
  db: D1Queryable,
  workspace: string,
  repo: string,
  branch: string,
): Promise<string[]> {
  try {
    return await resolveBranchLineage(db, workspace, repo, branch);
  } catch (err) {
    console.error(
      JSON.stringify({
        message: "promote: branch lineage lookup failed; sweeping the current name only",
        repo,
        branch,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return [branch];
  }
}
