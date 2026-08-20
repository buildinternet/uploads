/**
 * Canonical files vertical (issue #613 phase 1): `/:workspace/files*`,
 * mounted at `/v1/workspaces` in `index.ts` so its public paths are
 * `/v1/workspaces/:workspace/files*`. Dual-auth (`dualWorkspaceAuth`) —
 * either a session cookie or a bearer token reaches the same handlers below.
 *
 * Handler bodies are ported verbatim from their pre-#613 homes so response
 * shape is unchanged for every caller that reaches them (directly, or via
 * the old-path aliases in `routes/me.ts`):
 *  - list/search/facets/file-url/visibility: previously session-only, lived
 *    on `/me/workspaces/:name/...` in `routes/me.ts`.
 *  - delete: previously bearer-only path-keyed `DELETE /:key{.+}` on
 *    `/v1/:workspace/files` (`routes/files.ts`) — the shape this canonical
 *    route adopts, fixing the issue's "DELETE keys off a query param" wart
 *    for the canonical surface (the old `/me` query-param path is preserved
 *    verbatim as an alias, not removed).
 *  - sign/put/get/patch: shared with the legacy bearer router through
 *    `files-shared-handlers.ts`; both paths execute the same handler bodies.
 *
 * The canonical list/search response remains distinct from the legacy
 * bearer's list/search contract. Reconciling those shapes stays out of scope.
 *
 * `visibility` keeps the query-param key convention rather than a path
 * segment: this router already relies on Hono's `:key{.+}` catch-all for
 * `delete`, and `routes/files.ts` documents that a catch-all param followed
 * by a static suffix (e.g. `/:key{.+}/visibility`) does not reliably match
 * once the key contains raw slashes in the deployed (non-vitest) router.
 * Kept out of scope for this phase — see `.context/613-api-consolidation-plan.md`.
 */
import { ForbiddenError, NotFoundError, ValidationError } from "@uploads/errors";
import { createFilesRouter, signedDownloadUrl } from "@uploads/storage";
import { Hono, type Context, type Handler, type MiddlewareHandler } from "hono";
import {
  dualWorkspaceAuth,
  hasPreresolvedSession,
  resolveSessionUserId,
  type DualAuthVars,
} from "../dual-workspace-auth";
import { respondError } from "../error-response";
import { badKey, deleteObject, listObjects, setObjectVisibility } from "../files-core";
import { getMetadataForKeys, groupObjectsByPath, listFacets } from "../file-metadata";
import {
  normalizeSearchName,
  parseMetaQueryFilters,
  searchFilesByNameAndMeta,
} from "../file-search";
import { writeRateLimit } from "../guards";
import { memberWorkspaceOr404 } from "../org-workspaces";
import type { SessionVars } from "../session-auth";
import { objectPublicUrls, publicUrl, storage, storageConfig } from "../storage";
import { sanitizeVisibility, VISIBILITY_VALUES } from "../visibility";
import { loadWorkspaceRecord, requireScope } from "../workspace";
import {
  getFileHandler,
  patchFileHandler,
  putFileHandler,
  signFileHandler,
  type SharedFilesHandler,
} from "./files-shared-handlers";

// `requireScope`/`writeRateLimit` are typed against `WorkspaceVars`; this
// router's `DualAuthVars` is that type plus session fields, so a Context for
// one is always a valid Context for the other. Same cast pattern as
// `workspaceManageAuth` in `routes/workspaces.ts`.
function scoped(scope: Parameters<typeof requireScope>[0]): MiddlewareHandler<DualAuthVars> {
  return requireScope(scope) as unknown as MiddlewareHandler<DualAuthVars>;
}
const rateLimited = writeRateLimit as unknown as MiddlewareHandler<DualAuthVars>;
function shared(handler: SharedFilesHandler): Handler<DualAuthVars> {
  return handler as unknown as Handler<DualAuthVars>;
}

/**
 * Session-only member gate for `file-browser` (issue #613 final phase): a
 * bearer `Authorization` header 403s `file_browser_requires_session` — the
 * files-sdk folder-browser gateway has no bearer analog today and this PR
 * mints none, same posture as `workspace-members.ts`'s `sessionMemberGate`
 * and `workspace-settings.ts`'s tiered gates. Bearer discrimination mirrors
 * those: a preset (`hasPreresolvedSession`, e.g. a forwarded `/me` request)
 * always wins, unconditionally, before ever looking at the `Authorization`
 * header — a forwarded request keeps its original headers verbatim, so a
 * caller who authenticated to `/me` with a Better Auth bearer session (no
 * cookie) must not be rejected a second time here.
 */
function sessionFileBrowserGate(): MiddlewareHandler<DualAuthVars> {
  return async (c, next) => {
    if (!hasPreresolvedSession(c.req.raw) && c.req.header("Authorization")?.startsWith("Bearer ")) {
      throw new ForbiddenError("requires a session", { code: "file_browser_requires_session" });
    }
    const userId = await resolveSessionUserId(c as unknown as Context<SessionVars>);
    const name = c.req.param("workspace") ?? "";
    if (!name) throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    await memberWorkspaceOr404(c.env, userId, name);
    await next();
  };
}

export const workspaceFiles = new Hono<DualAuthVars>()

  // Folder-aware listing, D1 `gh.*` metadata always hydrated. Query params:
  // `prefix`/`cursor` pass straight through, `limit` defaults to 100
  // (clamped inside `listObjects`), `delimiter` enables S3-style "folder"
  // navigation via `listObjects`'s `prefixes`.
  .get("/:workspace/files", dualWorkspaceAuth(), scoped("files:read"), async (c) => {
    const record = c.get("workspace");
    const name = c.get("workspaceName");
    const { prefix, delimiter, cursor } = c.req.query();
    const limit = Number(c.req.query("limit") ?? 100) || 100;
    const {
      items,
      cursor: nextCursor,
      prefixes,
    } = await listObjects(c.env, record, { prefix, delimiter, limit, cursor });

    const metaByKey = await getMetadataForKeys(
      c.env.DB,
      name,
      items.map((item) => item.key),
    );
    const files = items.map((item) => ({ ...item, metadata: metaByKey.get(item.key) }));

    return c.json({ files, prefixes, cursor: nextCursor });
  })

  // Metadata + filename search — AND-of-equality `meta.*` filters and/or a
  // `name` substring term. Results carry no `visibility` (not in the D1
  // index — accepted caveat, same as the pre-#613 session route).
  .get("/:workspace/files/search", dualWorkspaceAuth(), scoped("files:read"), async (c) => {
    const record = c.get("workspace");
    const name = c.get("workspaceName");
    const query = c.req.query();
    const rawName = c.req.query("name");
    const nameTerm = rawName === undefined ? undefined : normalizeSearchName(rawName);
    const filters = parseMetaQueryFilters(query, (param) => c.req.queries(param));
    const hasMeta = Object.keys(filters).length > 0;

    if (!hasMeta && nameTerm === undefined) {
      throw new ValidationError("at least one meta.* filter or name is required", {
        code: "file_metadata_invalid_key",
      });
    }

    // `limit` narrows the page below the server cap (never raises it) — added
    // for the bearer-find migration (#613), whose callers pass `--limit`.
    const SEARCH_LIMIT = 100;
    const rawLimit = Number(c.req.query("limit") ?? SEARCH_LIMIT) || SEARCH_LIMIT;
    const pageSize = Math.min(Math.max(1, Math.floor(rawLimit)), SEARCH_LIMIT);
    const cfg = await storageConfig(c.env, record);
    const { matches, truncated } = await searchFilesByNameAndMeta(c.env, record, name, {
      filters: hasMeta ? filters : undefined,
      nameTerm,
      prefix: query.prefix,
      pageSize,
    });

    return c.json({
      items: matches.map((match) => {
        const urls = objectPublicUrls(c.env, cfg, match.key);
        return { key: match.key, url: urls.url, embedUrl: urls.embedUrl, metadata: match.metadata };
      }),
      truncated,
    });
  })

  // Facet discovery for the files filter bar: which metadata keys this
  // workspace actually contains, and (with `?key=`) that key's values.
  .get("/:workspace/files/facets", dualWorkspaceAuth(), scoped("files:read"), async (c) => {
    return c.json(await listFacets(c.env.DB, c.get("workspaceName"), c.req.query("key")));
  })

  // Recent uploads grouped by their `path` metadata value — the screenshots
  // page's single overview query (spec: docs/superpowers/specs/
  // 2026-08-10-screenshots-by-path-design.md). Drill-in reuses the sibling
  // `files/search?meta.path=…` route; this one answers "which paths, how
  // recent, first few keys" plus a thumbless `catalog` of every unique
  // (project, path) so the page can filter without a second query. `state`
  // is the one metadata key enriched — the page badges before/after and
  // nothing else, so no other keys leak into the payload.
  .get("/:workspace/files/by-path", dualWorkspaceAuth(), scoped("files:read"), async (c) => {
    const record = c.get("workspace");
    const name = c.get("workspaceName");
    const { groups, catalog, projects, truncated, catalogTruncated } = await groupObjectsByPath(
      c.env.DB,
      name,
    );
    const metaByKey = await getMetadataForKeys(
      c.env.DB,
      name,
      groups.flatMap((group) => group.recent),
      { metaKeys: ["state"] },
    );
    const cfg = await storageConfig(c.env, record);

    return c.json({
      groups: groups.map((group) => ({
        project: group.project,
        path: group.path,
        count: group.count,
        lastUpdated: group.lastUpdated,
        recent: group.recent.map((key) => {
          const urls = objectPublicUrls(c.env, cfg, key);
          const state = metaByKey.get(key)?.state;
          return {
            key,
            url: urls.url,
            embedUrl: urls.embedUrl,
            ...(state !== undefined ? { state } : {}),
          };
        }),
      })),
      catalog,
      projects,
      truncated,
      catalogTruncated,
    });
  })

  // Resolve a selected file to a usable URL (issue #613 wart fix: this used
  // to live outside `files/`, at `/me/workspaces/:name/file-url`). Public URL
  // when the workspace has one; otherwise a short-lived signed download URL
  // when the provider can sign; otherwise a typed error rather than a 200
  // with `url: null`.
  .get("/:workspace/files/file-url", dualWorkspaceAuth(), scoped("files:read"), async (c) => {
    const record = c.get("workspace");
    const key = c.req.query("key") ?? "";
    if (badKey(key)) throw new NotFoundError();
    const store = await storage(c.env, record);
    if (!(await store.exists(key))) throw new NotFoundError();

    const cfg = await storageConfig(c.env, record);
    const url = publicUrl(cfg, key);
    if (url) return c.json({ url });

    const signed = await signedDownloadUrl(store, key);
    if (signed) return c.json({ url: signed });

    throw new ValidationError(
      "no public or signed URL available for this workspace's storage configuration",
      { code: "file_url_unavailable" },
    );
  })

  // Toggle a file's `visibility` custom-metadata flag. See the module
  // docblock above for why the key stays a query param here.
  .patch(
    "/:workspace/files/visibility",
    dualWorkspaceAuth(),
    rateLimited,
    scoped("files:write"),
    async (c) => {
      const record = c.get("workspace");
      const key = c.req.query("key") ?? "";
      if (badKey(key)) throw new NotFoundError();

      const body = await c.req.json().catch(() => null);
      const requested = (body as { visibility?: unknown } | null)?.visibility;
      if (
        typeof requested !== "string" ||
        !(VISIBILITY_VALUES as readonly string[]).includes(requested)
      ) {
        throw new ValidationError('visibility must be "public" or "private"', {
          code: "invalid_visibility",
        });
      }

      const store = await storage(c.env, record);
      await setObjectVisibility(store, key, requested as "public" | "private");

      return c.json({ key, visibility: sanitizeVisibility(requested) ?? "public" });
    },
  )

  // files-sdk's folder-aware browser gateway (issue #613 final phase, moved
  // verbatim from `routes/me.ts`). Session-member-gated only — see
  // `sessionFileBrowserGate`'s docblock. Its path is `/:workspace/file-browser`
  // (a sibling of `/:workspace/files*`, not nested under it), so it can never
  // collide with this router's `/:workspace/files/:key{.+}` catch-alls
  // below regardless of registration order — kept above them anyway to match
  // this file's established "static routes before catch-alls" convention.
  .all("/:workspace/file-browser", sessionFileBrowserGate(), async (c) => {
    const name = c.req.param("workspace") ?? "";
    const record = await loadWorkspaceRecord(c.env, name);
    if (!record) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }
    const router = createFilesRouter({
      files: (await storage(c.env, record)).readonly(),
      operations: ["list"],
      maxListLimit: 100,
      // files-sdk resolves a signing secret even when signing operations are
      // disabled. This value is intentionally non-secret and cannot
      // authorize anything on this list-only, authenticated gateway.
      secret: `readonly-list:${name}`,
    });
    return router.handle(c.req.raw);
  })

  // These four key operations share their handler bodies with the legacy
  // bearer router. Keep every catch-all route after the static paths above:
  // Hono's `:key{.+}` matching otherwise risks swallowing a static suffix.
  .post(
    "/:workspace/files/sign",
    dualWorkspaceAuth(),
    rateLimited,
    scoped("files:write"),
    shared(signFileHandler),
  )
  .put(
    "/:workspace/files/:key{.+}",
    dualWorkspaceAuth(),
    rateLimited,
    scoped("files:write"),
    shared(putFileHandler),
  )
  .get(
    "/:workspace/files/:key{.+}",
    dualWorkspaceAuth(),
    scoped("files:read"),
    shared(getFileHandler),
  )
  .patch(
    "/:workspace/files/:key{.+}",
    dualWorkspaceAuth(),
    rateLimited,
    scoped("files:write"),
    shared(patchFileHandler),
  )

  // Delete a file — path-keyed (the shape the bearer-token surface already
  // used at `DELETE /v1/:workspace/files/:key{.+}`; see the module docblock
  // for why the pre-existing `/me` query-param DELETE is aliased rather than
  // migrated in place).
  .delete(
    "/:workspace/files/:key{.+}",
    dualWorkspaceAuth(),
    rateLimited,
    scoped("files:delete"),
    async (c) => {
      return c.json(
        await deleteObject(c.env, c.get("workspace"), c.req.param("key"), c.get("workspaceName")),
      );
    },
  )
  // This router is `.fetch()`-ed directly (not only mounted via `.route()`)
  // by the old-path aliases in `routes/me.ts`'s `forwardToWorkspaceFiles`, so
  // it needs its own error boundary — Hono's default unhandled-throw
  // response is a bare 500, which would erase every typed status code
  // (404/400/429/etc.) the handlers above throw.
  .onError((err, c) => respondError(c, err));
