/**
 * Phase 3 of the D1 attachment index (#955): the managed comment renders its
 * attachments from `github_attachments` instead of listing R2.
 *
 * Behind the Flagship flag `attachment-index-read`. Fails closed like the
 * other flags: a missing binding, a disabled flag, or a thrown evaluation
 * all mean "list R2 as before".
 *
 * List-on-miss: an empty index is trusted only when the target has no
 * `gh.ref` metadata row either. Every attach, promote, and CLI/MCP
 * `put --pr` stamps `gh.ref`, so a hit with no index rows means objects
 * that predate the index (#938) and need the backfill. Those targets fall
 * back to the R2 listing and log one `list-on-miss` line. `gh.ref` is
 * client-settable, but here it only decides whether to LIST; the listing,
 * not the metadata, decides what renders, so a spoofed row costs one extra
 * listing and nothing more.
 */

import { reportHandledError } from "@uploads/observability";
import { dbFor } from "./db-session";
import { filePageUrl } from "./files-core";
import { listAttachmentsForTarget } from "./github-attachment-index";
import { normalizeRepo } from "./github-private-prefixes";
import type { StorageConfig } from "@uploads/storage";
import { objectPublicUrls, storageConfigs } from "./storage";
import type { WorkspaceRecord } from "./workspace";
import type { AttachmentItem, GhTarget } from "./github-comment-render";

export const ATTACHMENT_INDEX_READ_FLAG = "attachment-index-read";

/** True only when the flag evaluates on. Never throws. */
export async function attachmentIndexReadEnabled(env: Env): Promise<boolean> {
  if (!env.FLAGS) return false;
  try {
    return await env.FLAGS.getBooleanValue(ATTACHMENT_INDEX_READ_FLAG, false);
  } catch {
    return false;
  }
}

export interface IndexedAttachments {
  items: AttachmentItem[];
  /**
   * The lane config each item's URLs came from, by key. The poster for a
   * video or PDF is written to the same lane as its object, so
   * `addCommentMetadata` derives the poster URL from this instead of probing
   * every lane with `exists()`.
   */
  laneConfigByKey: Map<string, StorageConfig>;
}

/**
 * The target's attachments from the index, with lane-aware URLs. Returns
 * null when the caller must list R2 instead: the index read failed, or the
 * index is empty for a target that has `gh.ref` metadata (list-on-miss).
 */
export async function readIndexedAttachments(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  target: GhTarget,
  linkToFilePage: boolean,
): Promise<IndexedAttachments | null> {
  let rows;
  try {
    rows = await listAttachmentsForTarget(dbFor(env), workspaceName, target.repo, target);
    if (rows.length === 0 && (await hasAttachmentRef(env, workspaceName, target))) {
      console.log(
        JSON.stringify({
          component: "attachment-index",
          event: "list-on-miss",
          workspace: workspaceName,
          repo: normalizeRepo(target.repo),
          kind: target.kind,
          num: target.num,
        }),
      );
      return null;
    }
  } catch (err) {
    reportHandledError(new Error("attachment index: read failed", { cause: err }));
    return null;
  }

  const laneConfigByKey = new Map<string, StorageConfig>();
  if (rows.length === 0) return { items: [], laneConfigByKey };

  // `lane_id` NULL is the active lane. An id no longer among the
  // workspace's lanes (a removed lane) also falls back to the active one,
  // the same lane a new upload would use.
  const configs = await storageConfigs(env, ws);
  const active = configs[0]!.config;
  const byLane = new Map(configs.map((lc) => [lc.laneId, lc.config]));
  const items = rows.map((row): AttachmentItem => {
    const cfg = (row.laneId !== null ? byLane.get(row.laneId) : undefined) ?? active;
    laneConfigByKey.set(row.objectKey, cfg);
    const urls = objectPublicUrls(env, cfg, row.objectKey);
    // Same projection as `listObjects`, so a render from the index matches
    // a render from the listing.
    const pageUrl = urls.url && ws.name ? filePageUrl(env, ws.name, row.objectKey) : undefined;
    return {
      key: row.objectKey,
      url: urls.url,
      embedUrl: urls.embedUrl,
      pageUrl: linkToFilePage ? pageUrl : null,
      ...(row.size != null ? { size: row.size } : {}),
      ...(row.contentType ? { contentType: row.contentType } : {}),
    };
  });
  return { items, laneConfigByKey };
}

/** One indexed seek on `file_metadata_lookup_idx`. `gh.ref` is `owner/name#num`, lowercased. */
async function hasAttachmentRef(
  env: Env,
  workspaceName: string,
  target: GhTarget,
): Promise<boolean> {
  const row = await dbFor(env)
    .prepare(
      `SELECT 1 AS hit FROM file_metadata
       WHERE workspace = ? AND meta_key = 'gh.ref' AND meta_value = ? LIMIT 1`,
    )
    .bind(workspaceName, `${normalizeRepo(target.repo)}#${target.num}`)
    .first<{ hit: number }>();
  return row !== null;
}
