import { Hono } from "hono";
import { deleteObject, listObjects } from "../files-core";
import { getMetadataForKeys, listFacets } from "../file-metadata";
import {
  clampSearchLimit,
  normalizeSearchName,
  parseMetaQueryFilters,
  searchFilesByNameAndMeta,
} from "../file-search";
import { objectPublicUrls, storageConfig } from "../storage";
import { requireScope, type WorkspaceVars } from "../workspace";
import { writeRateLimit } from "../guards";
import {
  getFileHandler,
  patchFileHandler,
  putFileHandler,
  signFileHandler,
} from "./files-shared-handlers";
import { dbFor } from "../db-session";
import { boundedDataRead } from "../data-read-bounds";

export const files = new Hono<WorkspaceVars>()

  // Presigned direct-to-bucket upload (workspace needs S3 HTTP credentials).
  .post("/sign", writeRateLimit, requireScope("files:write"), signFileHandler)

  // Upload: raw body PUT. The stored content type is sniffed from the bytes,
  // not taken from the client header — size/type policy is enforced in
  // files-core's putObject (shared with the MCP worker); see guards.ts.
  .put("/:key{.+}", writeRateLimit, requireScope("files:write"), putFileHandler)

  // Repeatable `meta.<key>=<value>` params and optional `?name=` switch the
  // listing to the shared D1/storage search path (issue #528) instead of the
  // R2 prefix-list below. No `meta.*` and no `name` leaves the existing R2
  // path untouched. Contract caveat: search-path items carry no `visibility`
  // annotation (that lives in R2 custom metadata and would cost a HEAD per
  // result to hydrate); callers needing the private marker must HEAD the
  // object. Meta-only responses omit `truncated` (pre-#528 shape); name
  // searches include it.
  .get("/", requireScope("files:read"), async (c) => {
    const query = c.req.query();
    const rawName = c.req.query("name");
    const nameTerm = rawName === undefined ? undefined : normalizeSearchName(rawName);
    const filters = parseMetaQueryFilters(query, (param) => c.req.queries(param));
    const hasMeta = Object.keys(filters).length > 0;

    if (hasMeta || nameTerm !== undefined) {
      const ws = c.get("workspace");
      const limitParam = c.req.query("limit");
      const pageSize = clampSearchLimit(limitParam ? Number(limitParam) || undefined : undefined);
      const [cfg, result] = await Promise.all([
        storageConfig(c.env, ws),
        boundedDataRead(
          c,
          () =>
            searchFilesByNameAndMeta(c.env, ws, c.get("workspaceName"), {
              filters: hasMeta ? filters : undefined,
              nameTerm,
              prefix: query.prefix,
              pageSize,
              ...(query.cursor ? { cursor: query.cursor } : {}),
            }),
          { name: "d1_files_search" },
        ),
      ]);
      const items = result.matches.map((match) => {
        const urls = objectPublicUrls(c.env, cfg, match.key);
        return {
          key: match.key,
          url: urls.url,
          embedUrl: urls.embedUrl,
          metadata: match.metadata,
        };
      });
      // Meta-only keeps the pre-#528 envelope (no `truncated` field). `cursor`
      // was always present and always null; it now carries the continuation
      // token when more pages exist (issue #829 §4).
      if (nameTerm === undefined) return c.json({ items, cursor: result.cursor });
      return c.json({ items, cursor: result.cursor, truncated: result.truncated });
    }

    const { prefix, cursor } = query;
    const limit = Number(c.req.query("limit") ?? 100) || 100;
    const page = await listObjects(c.env, c.get("workspace"), { prefix, limit, cursor });

    // `?metadata=1` hydrates each row's queryable D1 metadata — same spelling
    // as `GET /v1/:workspace/files/:key?metadata=1` and the same hydration the
    // session-authed `/me/workspaces/:name/files` already does. Unfiltered by
    // design: this is a general-purpose listing, not the managed-comment path
    // (which narrows to `path`/`state` at its own query — issue #365).
    const metadataParam = c.req.query("metadata");
    if (metadataParam !== "1" && metadataParam !== "true") return c.json(page);

    const metaByKey = await boundedDataRead(
      c,
      () =>
        getMetadataForKeys(
          dbFor(c.env),
          c.get("workspaceName"),
          page.items.map((item) => item.key),
        ),
      { name: "d1_files_meta" },
    );
    return c.json({
      ...page,
      items: page.items.map((item) => ({ ...item, metadata: metaByKey.get(item.key) })),
    });
  })

  // Facet discovery (issue #528) — token-authed twin of
  // `GET /me/workspaces/:name/files/facets`. Keys are user/agent-defined, so
  // agents need this to discover what is filterable before calling find_files.
  // Static path must register before `/:key{.+}` so "facets" is not treated
  // as an object key.
  .get("/facets", requireScope("files:read"), async (c) => {
    return c.json(
      await boundedDataRead(
        c,
        () => listFacets(dbFor(c.env), c.get("workspaceName"), c.req.query("key")),
        {
          name: "d1_files_facets",
        },
      ),
    );
  })

  // Metadata now lives on the key-at-tail routes (same shape PUT/GET/DELETE
  // already use) instead of a `/:key{.+}/metadata` suffix route: Hono's
  // production router does not reliably match a `{.+}` param followed by a
  // static suffix once the key contains raw slashes (real object keys always
  // do) — the vitest harness matches raw slashes so this passed locally, but
  // the deployed worker 404s on any real key. `?metadata=1` on GET and a bare
  // PATCH (which has no other meaning on this route) avoid the fragile
  // suffix pattern entirely.
  .get("/:key{.+}", requireScope("files:read"), getFileHandler)

  .patch("/:key{.+}", writeRateLimit, requireScope("files:write"), patchFileHandler)

  .delete("/:key{.+}", writeRateLimit, requireScope("files:delete"), async (c) => {
    return c.json(
      await deleteObject(c.env, c.get("workspace"), c.req.param("key"), c.get("workspaceName")),
    );
  });
