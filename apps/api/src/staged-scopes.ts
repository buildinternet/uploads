/** Read-only repository/branch discovery for the staged-media tray. */
import { ValidationError } from "@uploads/errors";
import { dbFor } from "./db-session";
import { b64urlDecode, b64urlEncode } from "./secrets";

interface ScopePair {
  repo: string;
  branch: string;
}

function readCursor(raw: string | undefined, workspace: string): ScopePair | undefined {
  if (raw === undefined) return undefined;
  try {
    if (raw.length > 4096) throw new Error("too long");
    const value = JSON.parse(new TextDecoder().decode(b64urlDecode(raw)));
    if (
      value.v !== 1 ||
      value.workspace !== workspace ||
      typeof value.repo !== "string" ||
      typeof value.branch !== "string" ||
      value.repo.length > 512 ||
      value.branch.length > 512
    )
      throw new Error("invalid scope");
    return { repo: value.repo, branch: value.branch };
  } catch {
    throw new ValidationError("Invalid staged scopes cursor.", {
      code: "staged_scopes_invalid_cursor",
    });
  }
}

export async function listStagedScopes(
  env: Env,
  workspace: string,
  options: { cursor?: string; limit: number },
): Promise<{ scopes: ScopePair[]; cursor: string | null }> {
  const after = readCursor(options.cursor, workspace);
  const result = await dbFor(env)
    .prepare(`
    SELECT DISTINCT repo.meta_value AS repo, branch.meta_value AS branch
    FROM file_metadata AS status
    JOIN file_metadata AS repo ON repo.workspace = status.workspace
      AND repo.object_key = status.object_key AND repo.meta_key = 'gh.repo'
    JOIN file_metadata AS branch ON branch.workspace = status.workspace
      AND branch.object_key = status.object_key AND branch.meta_key = 'gh.branch'
    JOIN file_metadata AS kind ON kind.workspace = status.workspace
      AND kind.object_key = status.object_key AND kind.meta_key = 'gh.kind'
    WHERE status.workspace = ? AND status.meta_key = 'gh.status'
      AND status.meta_value = 'staged' AND kind.meta_value = 'branch'
      ${after ? "AND (repo.meta_value > ? OR (repo.meta_value = ? AND branch.meta_value > ?))" : ""}
    ORDER BY repo.meta_value, branch.meta_value
    LIMIT ?
  `)
    .bind(workspace, ...(after ? [after.repo, after.repo, after.branch] : []), options.limit + 1)
    .all<ScopePair>();
  const scopes = result.results.slice(0, options.limit);
  const last = scopes.at(-1);
  return {
    scopes,
    cursor:
      result.results.length > options.limit && last
        ? b64urlEncode(new TextEncoder().encode(JSON.stringify({ v: 1, workspace, ...last })))
        : null,
  };
}

/** A branch in one repo with files still staged, for the PR comment's rename nudge. */
export interface StrandedBranch {
  /** Name to pass to `--from-branch` / MCP `promote`. */
  branch: string;
  files: number;
}

/** How far back the rename nudge looks for staged files. */
const STRANDED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const PLAIN_STAGED_KEY = /^gh\/[^/]+\/[^/]+\/branch\/([^/]+)\//;

/**
 * Branches in `repo` whose files this workspace staged in the last week and
 * never promoted, newest first, skipping `exclude` (the PR's head branch).
 * An empty PR shows these so a branch renamed without the CLI noticing can
 * be recovered with `--from-branch`. Starts from the `gh.repo` partial index
 * bounded by `updated_at`, then primary-key lookups, so no table scan. Plain
 * keys keep the staged spelling; private keys fall back to `gh.branch`.
 */
export async function recentStagedBranches(
  env: Env,
  workspace: string,
  repo: string,
  opts: { exclude?: string; limit?: number; now?: Date } = {},
): Promise<StrandedBranch[]> {
  const since = new Date((opts.now ?? new Date()).getTime() - STRANDED_WINDOW_MS).toISOString();
  const limit = opts.limit ?? 3;
  const exclude = opts.exclude?.toLowerCase() ?? "";
  const result = await dbFor(env)
    .prepare(`
    SELECT branch.meta_value AS branch, MIN(repo.object_key) AS sample_key,
      COUNT(*) AS files, MAX(repo.updated_at) AS latest
    FROM file_metadata AS repo
    JOIN file_metadata AS kind ON kind.workspace = repo.workspace
      AND kind.object_key = repo.object_key AND kind.meta_key = 'gh.kind'
    JOIN file_metadata AS status ON status.workspace = repo.workspace
      AND status.object_key = repo.object_key AND status.meta_key = 'gh.status'
    JOIN file_metadata AS branch ON branch.workspace = repo.workspace
      AND branch.object_key = repo.object_key AND branch.meta_key = 'gh.branch'
    WHERE repo.workspace = ? AND repo.meta_key = 'gh.repo' AND repo.meta_value = ?
      AND repo.updated_at >= ? AND kind.meta_value = 'branch' AND status.meta_value = 'staged'
      AND branch.meta_value != ?
    GROUP BY branch.meta_value
    ORDER BY latest DESC
    LIMIT ?
  `)
    .bind(workspace, repo.toLowerCase(), since, exclude, limit)
    .all<{ branch: string; sample_key: string; files: number }>();
  return result.results.map((row) => ({
    branch: PLAIN_STAGED_KEY.exec(row.sample_key)?.[1] ?? row.branch,
    files: row.files,
  }));
}
