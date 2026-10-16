/**
 * Clear a branch's staged set without deleting the objects (issue #1124).
 *
 * Sets `gh.status=unstaged` on files still staged for the branch. Promotion
 * skips that status, and `uploads staged` omits it. The object and its URL
 * stay. Needs `files:write` (a metadata merge), not `files:delete`.
 */
import { ghPrivateBranchKeyPrefix } from "./github-comment-render";
import { resolveGhKeyContextSafe } from "./github-private-prefix-service";
import { listBranchPrefixIds } from "./github-private-prefixes";
import { getMetadataForKeys, setFileMetadata } from "./file-metadata";
import { badKey, listObjects } from "./files-core";
import { NotFoundError, ValidationError } from "@uploads/errors";
import { storage } from "./storage";
import type { WorkspaceRecord } from "./workspace";
import { dbFor } from "./db-session";

const LIST_PAGE_LIMIT = 1000;
const MAX_LIST_PAGES = 20;

export interface UnstageFile {
  key: string;
  url: string | null;
  action: "unstaged" | "unchanged";
}

export interface UnstageResult {
  dryRun: boolean;
  repo?: string;
  branch?: string;
  files: UnstageFile[];
  /** True when a prefix still had another page after the list cap. */
  truncated?: boolean;
}

function sanitizeKeySegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "-");
}

function plainBranchPrefix(repo: string, branch: string): string {
  const [owner, name] = repo.split("/");
  return `gh/${sanitizeKeySegment(owner!)}/${sanitizeKeySegment(name!)}/branch/${sanitizeKeySegment(branch)}/`;
}

/**
 * Still in the branch's staged set. Matches the CLI's branch filter: a
 * different `gh.branch` is someone else's file, and promoted / unstaged /
 * already-copied files are already out of the set. Pull-request twins are
 * included here so a file `uploads staged` hides (because a newer PR copy
 * exists) still stops auto-promoting.
 */
export function stillStagedForBranch(
  meta: Record<string, string> | undefined,
  branch: string,
): boolean {
  const fileBranch = meta?.["gh.branch"];
  if (fileBranch && fileBranch.toLowerCase() !== branch.toLowerCase()) return false;
  if (meta?.["gh.status"] === "promoted" || meta?.["gh.status"] === "unstaged") return false;
  if (meta?.["gh.promoted-to"] || meta?.["gh.promoted-at"]) return false;
  return true;
}

async function listPrefix(
  env: Env,
  ws: WorkspaceRecord,
  prefix: string,
): Promise<{ items: { key: string; url: string | null }[]; truncated: boolean }> {
  const items: { key: string; url: string | null }[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const result = await listObjects(env, ws, { prefix, limit: LIST_PAGE_LIMIT, cursor });
    for (const item of result.items) items.push({ key: item.key, url: item.url });
    if (!result.cursor) return { items, truncated: false };
    cursor = result.cursor;
  }
  return { items, truncated: true };
}

export async function unstageGithubFiles(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  opts: { repo?: string; branch?: string; keys?: string[]; dryRun?: boolean },
): Promise<UnstageResult> {
  const dryRun = opts.dryRun === true;
  const keys = opts.keys?.filter((key) => key.length > 0) ?? [];
  if (keys.length > 0 && opts.branch) {
    throw new ValidationError("pass keys or branch, not both", { code: "invalid_body" });
  }
  if (keys.length === 0 && !opts.branch) {
    throw new ValidationError("branch or keys is required", { code: "invalid_body" });
  }
  if (opts.branch && !opts.repo) {
    throw new ValidationError("repo is required with branch", { code: "invalid_repo" });
  }

  if (keys.length > 0) {
    const store = await storage(env, ws);
    const files: UnstageFile[] = [];
    for (const key of keys) {
      if (badKey(key)) throw new ValidationError("invalid key", { code: "invalid_key" });
      if (!(await store.exists(key))) throw new NotFoundError();
      const meta = await getMetadataForKeys(dbFor(env), workspaceName, [key]);
      const status = meta.get(key)?.["gh.status"];
      if (status === "unstaged") {
        files.push({ key, url: null, action: "unchanged" });
        continue;
      }
      if (!dryRun) {
        await setFileMetadata(dbFor(env), workspaceName, key, { "gh.status": "unstaged" });
      }
      files.push({ key, url: null, action: "unstaged" });
    }
    return { dryRun, files };
  }

  const repo = opts.repo!;
  const branch = opts.branch!;
  const mode = await resolveGhKeyContextSafe(env, workspaceName, { repo, branch }, "unstage");
  const prefixes = [plainBranchPrefix(repo, branch)];
  if (mode.mode === "private") {
    const ids = await listBranchPrefixIds(dbFor(env), repo, branch, mode.prefixId);
    for (const id of ids) prefixes.push(ghPrivateBranchKeyPrefix(id));
  }

  const listed: { key: string; url: string | null }[] = [];
  let truncated = false;
  for (const prefix of prefixes) {
    const page = await listPrefix(env, ws, prefix);
    listed.push(...page.items);
    if (page.truncated) truncated = true;
  }
  const metaByKey = await getMetadataForKeys(
    dbFor(env),
    workspaceName,
    listed.map((item) => item.key),
  );
  const files: UnstageFile[] = [];
  for (const item of listed) {
    if (!stillStagedForBranch(metaByKey.get(item.key), branch)) continue;
    if (!dryRun) {
      await setFileMetadata(dbFor(env), workspaceName, item.key, { "gh.status": "unstaged" });
    }
    files.push({ key: item.key, url: item.url, action: "unstaged" });
  }
  return {
    dryRun,
    repo,
    branch,
    files,
    ...(truncated ? { truncated: true } : {}),
  };
}
