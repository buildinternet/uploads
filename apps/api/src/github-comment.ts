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

/** KV TTL for a cached comment id. A stale id self-heals: a 404 on PATCH drops
 * it and re-hunts. Long only to spare the hunt on active PRs. */
const COMMENT_ID_TTL = 60 * 60 * 24 * 30; // 30 days.

/** KV key for the managed comment's id, keyed by the coordinate the comment is
 * unique on (repo#num — one managed comment per PR/issue, shared marker). */
function commentCacheKey(target: Pick<GhTarget, "repo" | "num">): string {
  return `ghcomment:${target.repo.toLowerCase()}#${target.num}`;
}

/** One create/patch write. `status` is 0 for a thrown request (network error). */
type WriteOutcome = { ok: true; id?: number; commentUrl: string } | { ok: false; status: number };

const degradeFor = (status: number): "forbidden" | "unavailable" =>
  status === 403 ? "forbidden" : "unavailable";

/**
 * Create or patch the one managed comment (identified by `ATTACHMENTS_MARKER`)
 * on a PR/issue, authenticated as the GitHub App installation (not the
 * calling user). Degrade-safe: any failure — 403, other non-2xx, a thrown
 * token mint, or a network error — resolves to a `degrade` result rather than
 * throwing, since a failed bot comment must never fail the caller's request.
 *
 * A cached comment id (KV) is the fast path: re-editing media becomes a single
 * PATCH with no listing. The id is only an optimization — the marker in the
 * body stays authoritative, so a stale/deleted id (404) drops the cache and
 * falls back to the marker hunt, which pages through the whole thread.
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
  const cacheKey = commentCacheKey(target);

  const write = async (url: string, method: "POST" | "PATCH"): Promise<WriteOutcome> => {
    let res: Response;
    try {
      res = await githubFetch(fetchImpl, url, {
        method,
        headers: jsonHeaders,
        body: JSON.stringify({ body }),
      });
    } catch {
      return { ok: false, status: 0 };
    }
    if (!res.ok) return { ok: false, status: res.status };
    const parsed = (await res.json().catch(() => ({}))) as { id?: number; html_url?: string };
    return { ok: true, id: parsed.id, commentUrl: parsed.html_url ?? "" };
  };

  // Fast path: a cached id lets us PATCH the comment directly, no listing.
  const cachedId = (await env.GITHUB_CACHE.get(cacheKey)) as string | null;
  if (cachedId) {
    const r = await write(`${base}/issues/comments/${cachedId}`, "PATCH");
    if (r.ok) return { action: "updated", commentUrl: r.commentUrl };
    if (r.status !== 404) return { degrade: degradeFor(r.status) };
    // 404: the comment was deleted out from under us. Drop the stale id and
    // fall through to a fresh hunt + create.
    await env.GITHUB_CACHE.delete(cacheKey);
  }

  // Slow path: find the marker comment across all pages (a busy thread can push
  // it past the first 100), then patch it; otherwise create a new one.
  const found = await findMarkerComment(fetchImpl, token, base, target.num);
  if (found.degrade) return { degrade: found.degrade };
  const existing = found.comment;

  const r = existing
    ? await write(`${base}/issues/comments/${existing.id}`, "PATCH")
    : await write(`${base}/issues/${target.num}/comments`, "POST");
  if (!r.ok) return { degrade: degradeFor(r.status) };

  const id = existing?.id ?? r.id;
  if (id !== undefined) {
    await env.GITHUB_CACHE.put(cacheKey, String(id), { expirationTtl: COMMENT_ID_TTL });
  }
  return { action: existing ? "updated" : "created", commentUrl: r.commentUrl };
}

/**
 * Page through the PR/issue comments (oldest-first) until the marker comment is
 * found or the pages run out. Bounded so a pathological thread can't loop
 * unboundedly; the cap is far beyond any real attachments thread, and the id
 * cache means this hunt runs at most once per comment anyway.
 */
async function findMarkerComment(
  fetchImpl: typeof fetch,
  token: string,
  base: string,
  num: number,
): Promise<{ comment?: GhComment; degrade?: "forbidden" | "unavailable" }> {
  const MAX_PAGES = 20; // 2000 comments.
  for (let page = 1; page <= MAX_PAGES; page++) {
    let res: Response;
    try {
      res = await githubFetch(
        fetchImpl,
        `${base}/issues/${num}/comments?per_page=100&page=${page}`,
        {
          headers: githubHeaders(token),
        },
      );
    } catch {
      return { degrade: "unavailable" };
    }
    if (res.status === 403) return { degrade: "forbidden" };
    if (!res.ok) return { degrade: "unavailable" };
    const comments = (await res.json().catch(() => [])) as GhComment[];
    if (!Array.isArray(comments)) return {};
    const hit = comments.find(
      (c) => typeof c.body === "string" && c.body.includes(ATTACHMENTS_MARKER),
    );
    if (hit) return { comment: hit };
    if (comments.length < 100) return {}; // last page reached, not found.
  }
  return {}; // page cap hit without a match — treat as not found (create).
}
