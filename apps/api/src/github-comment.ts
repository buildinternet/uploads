/**
 * Server-side gather: list the calling workspace's own R2 objects under the
 * stable gh key prefix, plus its own galleries linked to the PR/issue
 * coordinate, then render the managed comment body via
 * `attachmentsCommentBody`. This is the trust boundary — the server renders
 * ONLY from the calling workspace's own data (its own bucket/prefix, its own
 * D1 rows scoped by workspace name).
 */

import { listObjects } from "./files-core";
import { findGalleriesByReference, listGalleryItems, type GalleryCursor } from "./galleries";
import { galleryUrl, hydrateOwnerGallery } from "./gallery-service";
import { parseExternalReference } from "./external-references";
import type { WorkspaceRecord } from "./workspace";
import {
  attachmentsCommentBody,
  ghKeyPrefix,
  type AttachmentItem,
  type GalleryCommentItem,
  type GhTarget,
} from "./github-comment-render";

/**
 * Gather a workspace's own PR/issue attachments + galleries into a rendered
 * managed-comment body.
 *
 * @param ws The calling workspace's storage record — objects are listed from
 *   its own bucket/prefix only.
 * @param workspaceName The calling workspace's slug — galleries are looked up
 *   scoped to this name only (D1 rows are tenant-scoped by this string, not
 *   by anything derived from `ws`).
 */
export async function gatherCommentBody(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  target: GhTarget,
): Promise<{ skip: true } | { skip: false; body: string; count: number }> {
  // Attachments: the workspace's own objects under the stable gh key prefix.
  const items: AttachmentItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await listObjects(env, ws, { prefix: ghKeyPrefix(target), limit: 1000, cursor });
    for (const o of page.items) items.push({ key: o.key, url: o.url, embedUrl: o.embedUrl });
    cursor = page.cursor ?? undefined;
  } while (cursor);

  // Galleries linked to this PR/issue (kind-agnostic coordinate), scoped to
  // this workspace only.
  const ref = parseExternalReference("github", `${target.repo.toLowerCase()}#${target.num}`);
  const galleries: GalleryCommentItem[] = [];
  if (ref.ok) {
    let gCursor: GalleryCursor | undefined;
    do {
      const page = await findGalleriesByReference(env.DB, workspaceName, ref.value.normalizedKey, {
        limit: 100,
        cursor: gCursor,
      });
      for (const rec of page.galleries) {
        const dto = await hydrateOwnerGallery(
          env,
          ws,
          rec,
          await listGalleryItems(env.DB, workspaceName, rec.id),
        );
        const previews = dto.items
          .filter((i) => i.status === "available" && i.url && i.contentType?.startsWith("image/"))
          .slice(0, 3)
          .map((i) => ({
            url: i.url as string,
            embedUrl: i.embedUrl,
            alt: i.altText ?? i.objectKey,
            itemUrl: i.pageUrl,
          }));
        galleries.push({ title: rec.title, url: galleryUrl(env, rec.id), previews });
      }
      gCursor = page.nextCursor ?? undefined;
    } while (gCursor);
  }

  const count = items.length + galleries.length;
  if (count === 0) return { skip: true };
  return { skip: false, body: attachmentsCommentBody(items, galleries), count };
}
