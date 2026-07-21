/**
 * Server-side promotion (phase 2a): copy a workspace's own branch-staged
 * attachments (`gh/<owner>/<name>/branch/<branch>/<filename>`) into a PR's
 * stable attachment prefix (`gh/<owner>/<name>/pull/<num>/<filename>`) so the
 * managed-comment gatherer (`github-comment.ts`, which lists that prefix)
 * picks them up unchanged. Pure workspace-data operation: no GitHub API call,
 * no installation lookup — just reading and writing the calling workspace's
 * own bucket/prefix and D1 rows.
 *
 * Originals are never deleted here (a later-phase reaper owns cleanup); a
 * second PR promoting the same branch is expected to re-promote and just
 * overwrites the destination copies (last-write-wins, same contract as any
 * other overwrite in this API).
 */

import { getMetadataForKeys, setFileMetadata } from "./file-metadata";
import { putObject } from "./files-core";
import { storage } from "./storage";
import { objectVisibility } from "./visibility";
import type { WorkspaceRecord } from "./workspace";

/** Max staged files processed per call — bounds the work a pathological branch prefix can trigger. */
export const PROMOTE_STAGED_CAP = 100;

/** Staged files older than this (by their `gh.staged-at` D1 tag) are skipped, not promoted. */
const FRESHNESS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Same segment-sanitization contract as the staged/attachment key layout: non-safe chars → `-`. */
function sanitizeKeySegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "-");
}

function stagedPrefix(owner: string, name: string, branch: string): string {
  return `gh/${sanitizeKeySegment(owner)}/${sanitizeKeySegment(name)}/branch/${sanitizeKeySegment(branch)}/`;
}

function destinationKey(owner: string, name: string, num: number, filename: string): string {
  return `gh/${sanitizeKeySegment(owner)}/${sanitizeKeySegment(name)}/pull/${num}/${filename}`;
}

/**
 * Missing or unparsable `staged-at` is treated as fresh — it's the workspace's
 * own data, and a missing tag shouldn't strand a file from ever promoting.
 */
function isFresh(stagedAt: string | undefined, nowMs: number): boolean {
  if (!stagedAt) return true;
  const parsed = Date.parse(stagedAt);
  if (!Number.isFinite(parsed)) return true;
  return nowMs - parsed <= FRESHNESS_WINDOW_MS;
}

export interface PromoteTarget {
  /** "owner/name", already validated by the caller. */
  repo: string;
  num: number;
  branch: string;
}

export interface PromoteSkip {
  key: string;
  reason: string;
}

export interface PromoteResult {
  /** Destination keys written by this call. */
  promoted: string[];
  skipped: PromoteSkip[];
}

/**
 * Copy the calling workspace's fresh branch-staged attachments into the
 * target PR's attachment prefix. Degrade-safe: a single-file copy failure is
 * collected into `skipped` rather than failing the whole call. Idempotent —
 * re-running overwrites the destination copies.
 */
export async function promoteBranchAttachments(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  target: PromoteTarget,
): Promise<PromoteResult> {
  const [owner, name] = target.repo.split("/");
  const prefix = stagedPrefix(owner, name, target.branch);
  const store = await storage(env, ws);

  const promoted: string[] = [];
  const skipped: PromoteSkip[] = [];

  // Enumerate every staged key under the prefix (bounded pagination — a
  // pathological prefix can't loop forever), then split at the cap: the head
  // gets processed, everything past it is reported as skipped rather than
  // silently dropped.
  const keys: string[] = [];
  let cursor: string | undefined;
  const MAX_LIST_PAGES = 50; // 50k objects at the 1000-per-page ceiling; far beyond any real staging prefix.
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const result = await store.list({ prefix, limit: 1000, cursor });
    for (const item of result.items) keys.push(item.key);
    cursor = result.cursor ?? undefined;
    if (!cursor) break;
  }

  if (keys.length === 0) return { promoted, skipped };

  const toProcess = keys.slice(0, PROMOTE_STAGED_CAP);
  for (const key of keys.slice(PROMOTE_STAGED_CAP)) {
    skipped.push({ key, reason: "cap_exceeded" });
  }

  const metaByKey = await getMetadataForKeys(env.DB, workspaceName, toProcess);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const ref = `${owner}/${name}#${target.num}`.toLowerCase();

  for (const key of toProcess) {
    const stagedAt = metaByKey.get(key)?.["gh.staged-at"];
    if (!isFresh(stagedAt, nowMs)) {
      skipped.push({ key, reason: "stale" });
      continue;
    }

    const filename = key.slice(prefix.length);
    if (!filename) {
      skipped.push({ key, reason: "invalid_key" });
      continue;
    }
    const destKey = destinationKey(owner, name, target.num, filename);

    try {
      const source = await store.download(key);
      const bytes = new Uint8Array(await source.arrayBuffer());
      const visibility = objectVisibility(source.metadata);

      // A full replace (opts.metadata): the copy gets a fresh, self-contained
      // gh.* tag set rather than inheriting the staged original's tags.
      await putObject(env, ws, destKey, bytes, workspaceName, {
        provenance: source.metadata,
        visibility,
        metadata: {
          "gh.repo": `${owner}/${name}`.toLowerCase(),
          "gh.kind": "pull",
          "gh.number": String(target.num),
          "gh.ref": ref,
          "gh.branch": target.branch,
          "gh.promoted-at": nowIso,
        },
      });
      promoted.push(destKey);

      // Merge (not replace) onto the staged original: mark it promoted
      // without disturbing its own gh.repo/gh.kind/gh.branch/gh.staged-at tags.
      await setFileMetadata(env.DB, workspaceName, key, {
        "gh.promoted-to": ref,
        "gh.promoted-at": nowIso,
      });
    } catch (err) {
      skipped.push({ key, reason: err instanceof Error ? err.message : "copy_failed" });
    }
  }

  return { promoted, skipped };
}
