/**
 * Server-side gather: list the calling workspace's own R2 objects under the
 * stable gh key prefix, plus its own galleries linked to the PR/issue
 * coordinate, then render the managed comment body via
 * `attachmentsCommentBody`. This is the trust boundary — the server renders
 * ONLY from the calling workspace's own data (its own bucket/prefix, its own
 * D1 rows scoped by workspace name).
 */

import { listObjects } from "./files-core";
import { getMetadataForKeys } from "./file-metadata";
import { findGalleriesByReference, listGalleryItems, type GalleryCursor } from "./galleries";
import { galleryUrl, hydrateOwnerGallery } from "./gallery-service";
import { parseExternalReference } from "./external-references";
import { objectPublicUrls, storageConfig } from "./storage";
import { posterKeyFor } from "./poster";
import type { WorkspaceRecord } from "./workspace";
import { githubFetch, githubHeaders, installationToken, type GithubAppConfig } from "./github-app";
import {
  attachmentsCommentBody,
  attachmentsMarker,
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
): Promise<{ body: string; count: number }> {
  // Attachments (R2 list) and galleries (D1) are independent reads — overlap
  // them so the request only waits the longer of the two, not their sum.
  const [items, galleries] = await Promise.all([
    gatherAttachments(env, ws, workspaceName, target),
    gatherGalleries(env, ws, workspaceName, target),
  ]);

  const count = items.length + galleries.length;
  const marker = attachmentsMarker(workspaceName);
  // count may be 0 — attachmentsCommentBody renders a neutral empty state.
  // Callers gate create-vs-patch on count (see upsertBotComment createIfMissing).
  return { body: attachmentsCommentBody(items, galleries, marker), count };
}

/**
 * The only metadata keys the managed comment reads or renders (issue #365,
 * extended for #299). The `video.*` keys are server-owned derived facts about
 * the file itself — not EXIF-derived keys like `device`/`software` — so the
 * narrowness rationale still holds for a surface that posts publicly.
 */
const COMMENT_META_KEYS = [
  "path",
  "state",
  "video.poster",
  "video.duration",
  "video.width",
  "video.height",
];

/** The workspace's own objects under the stable gh key prefix. */
async function gatherAttachments(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  target: GhTarget,
): Promise<AttachmentItem[]> {
  // Per-workspace choice (issue #304): default (undefined/true) links the
  // managed comment's attachments to their `/f/` file page (issue #301's
  // behavior); `false` links to raw object bytes instead. Attachments only —
  // does not affect gallery `itemUrl` below, which is a separate feature.
  const linkToFilePage = ws.githubCommentLinkToFilePage !== false;
  const showMetadata = ws.githubCommentShowMetadata !== false; // issue #365
  const items: AttachmentItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await listObjects(env, ws, {
      prefix: ghKeyPrefix(target),
      limit: 1000,
      cursor,
    });
    for (const o of page.items)
      items.push({
        key: o.key,
        url: o.url,
        embedUrl: o.embedUrl,
        pageUrl: linkToFilePage ? o.pageUrl : null,
      });
    cursor = page.cursor ?? undefined;
  } while (cursor);

  if (!showMetadata || items.length === 0) return items;

  // D1 rows are tenant-scoped by `workspaceName` (the caller's own slug), not
  // by anything derived from `ws` — same trust boundary as gatherGalleries.
  const metaByKey = await getMetadataForKeys(
    env.DB,
    workspaceName,
    items.map((item) => item.key),
    { metaKeys: COMMENT_META_KEYS },
  );
  const cfg = await storageConfig(env, ws);
  for (const item of items) {
    const meta = metaByKey.get(item.key);
    if (!meta) continue;
    const { path, state } = meta;
    if (path || state) {
      item.meta = { ...(path ? { path } : {}), ...(state ? { state } : {}) };
    }
    // `video.poster` is a presence flag only. The URL is always recomputed
    // from the object key, so a client-settable row can never decide what
    // image renders in a public comment.
    if (meta["video.poster"] === "1") {
      const posterUrls = objectPublicUrls(env, cfg, posterKeyFor(item.key));
      item.posterUrl = posterUrls.embedUrl ?? posterUrls.url;
      const duration = Number(meta["video.duration"]);
      const width = Number(meta["video.width"]);
      const height = Number(meta["video.height"]);
      item.videoMeta = {
        ...(Number.isFinite(duration) && duration > 0 ? { durationSeconds: duration } : {}),
        ...(Number.isFinite(width) && width > 0 ? { width } : {}),
        ...(Number.isFinite(height) && height > 0 ? { height } : {}),
      };
    }
  }
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

/** KV key for the managed comment's id, keyed by the workspace + coordinate the
 * comment is unique on (repo#num — one managed comment per PR/issue per
 * workspace, phase 4b). A cache entry written under the pre-4b key format
 * (`ghcomment:<repo>#<num>`, no workspace dimension) simply misses under this
 * key and falls through to a fresh marker hunt — no migration needed. */
export function commentCacheKey(
  workspaceName: string,
  target: Pick<GhTarget, "repo" | "num">,
): string {
  return `ghcomment:${workspaceName}:${target.repo.toLowerCase()}#${target.num}`;
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
 *
 * `forceHunt` skips that fast path and always hunts (issue #480). The dedupe
 * below only runs on the hunt, so while the cache is warm a race-created
 * duplicate would otherwise survive until the id expires (30 days). Callers
 * whose whole intent is "make the comment state correct" — the explicit
 * `uploads comment` resync — pay one listing to bound a duplicate's lifetime
 * to the next such call. High-frequency attach/promote syncs keep the fast path.
 */
export async function upsertBotComment(
  env: Env,
  cfg: GithubAppConfig,
  installationId: number,
  target: Pick<GhTarget, "repo" | "num">,
  body: string,
  workspaceName: string,
  fetchImpl: typeof fetch = fetch,
  opts: { createIfMissing?: boolean; forceHunt?: boolean } = {},
): Promise<
  | { action: "created" | "updated"; commentUrl: string }
  | { action: "skipped" }
  | { degrade: "forbidden" | "unavailable" }
> {
  const createIfMissing = opts.createIfMissing ?? true;
  const token = await installationToken(env, cfg, installationId, fetchImpl);
  if (!token) return { degrade: "unavailable" };
  const base = `https://api.github.com/repos/${target.repo}`;
  const jsonHeaders = { ...githubHeaders(token), "content-type": "application/json" };
  const cacheKey = commentCacheKey(workspaceName, target);
  const marker = attachmentsMarker(workspaceName);

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
  // Skipped entirely under `forceHunt` — the caller wants the dedupe pass.
  const cachedId = opts.forceHunt
    ? null
    : ((await env.GITHUB_CACHE.get(cacheKey)) as string | null);
  if (cachedId) {
    const r = await write(`${base}/issues/comments/${cachedId}`, "PATCH");
    if (r.ok) return { action: "updated", commentUrl: r.commentUrl };
    if (r.status !== 404) return { degrade: degradeFor(r.status) };
    // 404: the comment was deleted out from under us. Drop the stale id and
    // fall through to a fresh hunt + create.
    await env.GITHUB_CACHE.delete(cacheKey);
  }

  // Slow path: find the marker comment across all pages (a busy thread can push
  // it past the first 100), then patch it; otherwise create a new one. Hunts
  // the namespaced marker first; a legacy (pre-4b, unnamespaced) comment is
  // adopted — `body` already carries the namespaced marker, so patching it
  // migrates the comment in place.
  const found = await findMarkerComment(fetchImpl, token, base, target.num, marker);
  if (found.degrade) return { degrade: found.degrade };
  const existing = found.comment;

  if (!existing && !createIfMissing) return { action: "skipped" };
  const r = existing
    ? await write(`${base}/issues/comments/${existing.id}`, "PATCH")
    : await write(`${base}/issues/${target.num}/comments`, "POST");
  if (!r.ok) return { degrade: degradeFor(r.status) };

  // Self-healing dedupe (issue #470): a create race can leave two marker
  // comments on the thread; the extras would drift stale forever since the
  // hunt keeps only the oldest. Delete them best-effort — a failed delete
  // must never fail the caller's request, and the next sync retries anyway.
  for (const extra of found.extras ?? []) {
    try {
      await githubFetch(fetchImpl, `${base}/issues/comments/${extra.id}`, {
        method: "DELETE",
        headers: jsonHeaders,
      });
    } catch {
      // Best effort only.
    }
  }

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
 *
 * Prefers a comment carrying `marker` (the namespaced, per-workspace marker);
 * if none is found across every page, falls back to a comment carrying the
 * shared legacy `ATTACHMENTS_MARKER` (pre-4b, unnamespaced) so it can be
 * adopted and migrated in place. When `marker` IS the legacy marker (no
 * workspace to namespace with) this collapses to a single hunt, unchanged
 * from pre-4b behavior.
 *
 * Collects EVERY comment carrying `marker` (a create race can leave more than
 * one — issue #470): the oldest is `comment`, the rest come back as `extras`
 * for the caller to delete. Only exact-`marker` hits are ever extras — a
 * legacy (unnamespaced) comment may belong to a different workspace, so it is
 * adopted at most, never deleted.
 */
async function findMarkerComment(
  fetchImpl: typeof fetch,
  token: string,
  base: string,
  num: number,
  marker: string,
): Promise<{ comment?: GhComment; extras?: GhComment[]; degrade?: "forbidden" | "unavailable" }> {
  const MAX_PAGES = 20; // 2000 comments.
  let legacyHit: GhComment | undefined;
  const hits: GhComment[] = [];
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
    if (!Array.isArray(comments)) break;
    hits.push(...comments.filter((c) => typeof c.body === "string" && c.body.includes(marker)));
    if (!legacyHit && marker !== ATTACHMENTS_MARKER) {
      legacyHit = comments.find(
        (c) => typeof c.body === "string" && c.body.includes(ATTACHMENTS_MARKER),
      );
    }
    if (comments.length < 100) break; // last page reached.
  }
  // Comments list oldest-first, so hits[0] is the oldest marker comment.
  if (hits.length > 0) {
    // In legacy mode (no workspace to namespace with) our "exact" marker IS
    // the shared one, so a second hit is not our own duplicate — it may be
    // another workspace's comment. Adopt the oldest and never delete: the
    // adopt-only contract is about the marker being ambiguous, which is just
    // as true when it is the marker we are hunting on.
    const extras = marker === ATTACHMENTS_MARKER ? undefined : hits.slice(1);
    return { comment: hits[0], extras };
  }
  return { comment: legacyHit }; // best effort — adopt a legacy hit if seen.
}
