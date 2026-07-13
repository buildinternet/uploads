import { NotFoundError, UnauthorizedError } from "@uploads/errors";
import { Hono } from "hono";
import { badKey } from "../files-core";
import { publicUrl, storage, storageConfig } from "../storage";
import { objectVisibility } from "../visibility";
import { loadWorkspaceRecord, type WorkspaceVars } from "../workspace";

/**
 * Public, unauthenticated metadata for a single object, so `apps/web` (which has
 * no storage bindings) can render a chrome-wrapped file page at
 * `uploads.sh/f/<workspace>/<key>` (issue #135).
 *
 * Security posture mirrors public galleries: exact-key lookup only, no listing,
 * no bearer token in the browser. It adds no new *access* — the bytes are already
 * served unsigned off the R2 public domain — only a curated metadata view. Raw
 * provenance is deliberately omitted here (unlike the authenticated HEAD).
 *
 * `visibility: "private"` (#139) gates this JSON endpoint with 401 `auth_required`.
 * NOTE this is metadata-only enforcement: on a workspace with `publicBaseUrl`, the
 * raw object bytes remain reachable unsigned straight off that public domain — this
 * route never controlled byte access, only this curated view. Real privacy for a
 * "private" object requires a workspace with no `publicBaseUrl` (signed URLs only),
 * which is out of scope for this endpoint.
 */
export const publicFiles = new Hono<WorkspaceVars>().get("/:workspace/:key{.+}", async (c) => {
  const workspace = c.req.param("workspace");
  const key = c.req.param("key");
  if (badKey(key)) throw new NotFoundError();

  // Validates the workspace name (WS_NAME_RE) before the KV lookup, matching the
  // authenticated paths rather than trusting the raw path param.
  const record = await loadWorkspaceRecord(c.env, workspace);
  if (!record) throw new NotFoundError();

  // Phase 1 is public-workspace-only: resolving the public URL doubles as the
  // visibility gate. A workspace without a public base URL cannot be wrapped
  // here — that is #123's signed-URL territory, swapped in when it lands.
  const url = publicUrl(await storageConfig(c.env, record), key);
  if (!url) throw new NotFoundError();

  const store = await storage(c.env, record);
  if (!(await store.exists(key))) throw new NotFoundError();
  const meta = await store.head(key);

  if (objectVisibility(meta.metadata ?? undefined)) {
    throw new UnauthorizedError("sign in to view this file", { code: "auth_required" });
  }

  return c.json({
    workspace,
    key,
    url,
    size: meta.size ?? 0,
    contentType: meta.type ?? "application/octet-stream",
    ...(meta.lastModified != null ? { uploaded: new Date(meta.lastModified).toISOString() } : {}),
  });
});
