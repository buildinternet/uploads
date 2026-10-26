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
