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
import { githubFetch, githubHeaders, installationToken, type GithubAppConfig } from "./github-app";
import {
  attachmentsCommentBody,
  ghKeyPrefix,
  ATTACHMENTS_MARKER,
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
  // Attachments (R2 list) and galleries (D1) are independent reads — overlap
  // them so the request only waits the longer of the two, not their sum.
  const [items, galleries] = await Promise.all([
    gatherAttachments(env, ws, target),
    gatherGalleries(env, ws, workspaceName, target),
  ]);

  const count = items.length + galleries.length;
  if (count === 0) return { skip: true };
  return { skip: false, body: attachmentsCommentBody(items, galleries), count };
}

/** The workspace's own objects under the stable gh key prefix. */
async function gatherAttachments(
  env: Env,
  ws: WorkspaceRecord,
  target: GhTarget,
): Promise<AttachmentItem[]> {
  const items: AttachmentItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await listObjects(env, ws, { prefix: ghKeyPrefix(target), limit: 1000, cursor });
    for (const o of page.items) items.push({ key: o.key, url: o.url, embedUrl: o.embedUrl });
    cursor = page.cursor ?? undefined;
  } while (cursor);
  return items;
}

/**
 * Galleries linked to this PR/issue (kind-agnostic coordinate), scoped to this
 * workspace only. Each page's galleries hydrate concurrently (mirrors the CLI's
 * original `Promise.all` gather).
 */
async function gatherGalleries(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  target: GhTarget,
): Promise<GalleryCommentItem[]> {
  const ref = parseExternalReference("github", `${target.repo.toLowerCase()}#${target.num}`);
  if (!ref.ok) return [];
  const galleries: GalleryCommentItem[] = [];
  let gCursor: GalleryCursor | undefined;
  do {
    const page = await findGalleriesByReference(env.DB, workspaceName, ref.value.normalizedKey, {
      limit: 100,
      cursor: gCursor,
    });
    const pageItems = await Promise.all(
      page.galleries.map(async (rec) => {
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
        return { title: rec.title, url: galleryUrl(env, rec.id), previews };
      }),
    );
    galleries.push(...pageItems);
    gCursor = page.nextCursor ?? undefined;
  } while (gCursor);
  return galleries;
}

interface GhComment {
  id: number;
  body: string;
  html_url: string;
}

/**
 * Create or patch the one managed comment (identified by `ATTACHMENTS_MARKER`)
 * on a PR/issue, authenticated as the GitHub App installation (not the
 * calling user). Degrade-safe: any failure — 403, other non-2xx, a thrown
 * token mint, or a network error — resolves to a `degrade` result rather than
 * throwing, since a failed bot comment must never fail the caller's request.
 */
export async function upsertBotComment(
  env: Env,
  cfg: GithubAppConfig,
  installationId: number,
  target: Pick<GhTarget, "repo" | "num">,
  body: string,
  fetchImpl: typeof fetch = fetch,
): Promise<
  { action: "created" | "updated"; commentUrl: string } | { degrade: "forbidden" | "unavailable" }
> {
  const token = await installationToken(env, cfg, installationId, fetchImpl);
  if (!token) return { degrade: "unavailable" };
  const base = `https://api.github.com/repos/${target.repo}`;
  const jsonHeaders = { ...githubHeaders(token), "content-type": "application/json" };

  let listRes: Response;
  try {
    listRes = await githubFetch(fetchImpl, `${base}/issues/${target.num}/comments?per_page=100`, {
      headers: githubHeaders(token),
    });
  } catch {
    return { degrade: "unavailable" };
  }
  if (listRes.status === 403) return { degrade: "forbidden" };
  if (!listRes.ok) return { degrade: "unavailable" };
  const comments = (await listRes.json().catch(() => [])) as GhComment[];
  const existing = Array.isArray(comments)
    ? comments.find((c) => typeof c.body === "string" && c.body.includes(ATTACHMENTS_MARKER))
    : undefined;

  const write = async (
    url: string,
    method: "POST" | "PATCH",
  ): Promise<
    { ok: true; commentUrl: string } | { ok: false; degrade: "forbidden" | "unavailable" }
  > => {
    let res: Response;
    try {
      res = await githubFetch(fetchImpl, url, {
        method,
        headers: jsonHeaders,
        body: JSON.stringify({ body }),
      });
    } catch {
      return { ok: false, degrade: "unavailable" };
    }
    if (res.status === 403) return { ok: false, degrade: "forbidden" };
    if (!res.ok) return { ok: false, degrade: "unavailable" };
    const parsed = (await res.json().catch(() => ({}))) as { html_url?: string };
    return { ok: true, commentUrl: parsed.html_url ?? "" };
  };

  const url = existing
    ? `${base}/issues/comments/${existing.id}`
    : `${base}/issues/${target.num}/comments`;
  const r = await write(url, existing ? "PATCH" : "POST");
  if (!r.ok) return { degrade: r.degrade };
  return { action: existing ? "updated" : "created", commentUrl: r.commentUrl };
}
