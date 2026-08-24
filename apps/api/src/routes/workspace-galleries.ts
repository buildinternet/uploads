/**
 * Canonical galleries vertical (issue #613 phase 2): `/:workspace/galleries*`,
 * mounted at `/v1/workspaces` in `index.ts` so its public paths are
 * `/v1/workspaces/:workspace/galleries*`. Dual-auth (`dualWorkspaceAuth`) —
 * either a session cookie or a bearer token reaches the same handlers below.
 *
 * Handler bodies are the exact same functions the pre-#613 bearer router
 * (`routes/galleries.ts`, still mounted verbatim at `/v1/:workspace/galleries`)
 * calls — extracted there so this router can reuse them instead of
 * copy-pasting bodies, same "response shape can't drift" guarantee phase 1
 * established for files via a `.fetch()` re-dispatch. Galleries doesn't use
 * that re-dispatch pattern itself (that's for OLD-path aliases forwarding
 * INTO this canonical router — see `forwardToWorkspaceUsage`/the galleries
 * divergence note in `.context/613-api-consolidation-plan.md` for why the
 * old `/me/workspaces/:name/galleries` list is NOT aliased here).
 *
 * `GET /:workspace/galleries` is the one exception to the "reuse
 * `routes/galleries.ts`'s handler bodies verbatim" rule above (issue #613
 * final phase): it uses a LOCAL `listGalleriesEnrichedHandler`, not the
 * shared `listGalleriesHandler`, so the enrichment below can't leak onto the
 * pre-existing bearer-only `/v1/:workspace/galleries` list (`routes/galleries.ts`,
 * mounted separately in `index.ts`) — that handler function is shared
 * between this router and the old one, so mutating it in place would have
 * changed both surfaces at once. See `listGalleriesEnrichedHandler`'s
 * docblock.
 */
import { ValidationError } from "@uploads/errors";
import { dbFor } from "../db-session";
import { boundedDataRead } from "../data-read-bounds";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { dualWorkspaceAuth, type DualAuthVars } from "../dual-workspace-auth";
import { respondError } from "../error-response";
import { listGalleries } from "../galleries";
import { decodeGalleryCursor, encodeGalleryCursor, galleryListSummaries } from "../gallery-service";
import { writeRateLimit } from "../guards";
import { requireScope, type WorkspaceVars } from "../workspace";
import {
  addExternalReferenceHandler,
  addGalleryItemHandler,
  createGalleryHandler,
  deleteGalleryHandler,
  galleriesByReferenceHandler,
  getGalleryHandler,
  listExternalReferencesHandler,
  removeExternalReferenceHandler,
  removeGalleryItemHandler,
  reorderGalleryItemsHandler,
  updateGalleryHandler,
} from "./galleries";

/**
 * `GET /:workspace/galleries` — canonical list, enriched with `itemCount`/
 * `references`/`previewUrl` (cover thumbnail) per gallery
 * (`galleryListSummaries`, `gallery-service.ts`) for EVERY caller, bearer and
 * session alike (issue #613 final phase). Body is
 * otherwise identical to `listGalleriesHandler` (`routes/galleries.ts`):
 * same `limit`/`cursor` query contract, same `nextCursor` envelope —
 * `GalleryListSummaryDto` extends `GallerySummaryDto` with additive fields
 * only, so this is a strict superset of the old canonical shape. Local to
 * this router (not exported/shared) so it can never be reused by the
 * pre-existing bearer-only `/v1/:workspace/galleries` list, which keeps its
 * current cheaper `gallerySummary` projection untouched.
 */
async function listGalleriesEnrichedHandler(c: Context<WorkspaceVars>) {
  const rawLimit = c.req.query("limit");
  const limit = rawLimit === undefined ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new ValidationError("limit must be an integer from 1 to 100.");
  const name = c.get("workspaceName");
  const page = await boundedDataRead(
    c,
    () =>
      listGalleries(dbFor(c.env), name, {
        limit,
        cursor: decodeGalleryCursor(c.req.query("cursor")),
      }),
    { name: "d1_galleries_list" },
  );
  return c.json({
    // The workspace record (not just the name) so `galleryListSummaries` can
    // resolve storage for each row's cover `previewUrl` (additive field).
    galleries: await galleryListSummaries(c.env, c.get("workspace"), page.galleries),
    nextCursor: page.nextCursor ? encodeGalleryCursor(page.nextCursor) : null,
  });
}

// Same cross-cast pattern as `routes/workspace-files.ts`'s `scoped`: these
// helpers/handlers are typed against `WorkspaceVars`, a strict subset of this
// router's `DualAuthVars`, so a Context for one is always a valid Context for
// the other.
function scoped(scope: Parameters<typeof requireScope>[0]): MiddlewareHandler<DualAuthVars> {
  return requireScope(scope) as unknown as MiddlewareHandler<DualAuthVars>;
}
const rateLimited = writeRateLimit as unknown as MiddlewareHandler<DualAuthVars>;

export const workspaceGalleries = new Hono<DualAuthVars>()
  .post(
    "/:workspace/galleries",
    dualWorkspaceAuth(),
    rateLimited,
    scoped("files:write"),
    createGalleryHandler as unknown as MiddlewareHandler<DualAuthVars>,
  )
  .get(
    "/:workspace/galleries",
    dualWorkspaceAuth(),
    scoped("files:read"),
    listGalleriesEnrichedHandler as unknown as MiddlewareHandler<DualAuthVars>,
  )
  .get(
    "/:workspace/galleries/by-reference",
    dualWorkspaceAuth(),
    scoped("files:read"),
    galleriesByReferenceHandler as unknown as MiddlewareHandler<DualAuthVars>,
  )
  .get(
    "/:workspace/galleries/:id",
    dualWorkspaceAuth(),
    scoped("files:read"),
    getGalleryHandler as unknown as MiddlewareHandler<DualAuthVars>,
  )
  .patch(
    "/:workspace/galleries/:id",
    dualWorkspaceAuth(),
    rateLimited,
    scoped("files:write"),
    updateGalleryHandler as unknown as MiddlewareHandler<DualAuthVars>,
  )
  .delete(
    "/:workspace/galleries/:id",
    dualWorkspaceAuth(),
    rateLimited,
    scoped("files:write"),
    deleteGalleryHandler as unknown as MiddlewareHandler<DualAuthVars>,
  )
  .post(
    "/:workspace/galleries/:id/items",
    dualWorkspaceAuth(),
    rateLimited,
    scoped("files:write"),
    addGalleryItemHandler as unknown as MiddlewareHandler<DualAuthVars>,
  )
  .put(
    "/:workspace/galleries/:id/items/order",
    dualWorkspaceAuth(),
    rateLimited,
    scoped("files:write"),
    reorderGalleryItemsHandler as unknown as MiddlewareHandler<DualAuthVars>,
  )
  .delete(
    "/:workspace/galleries/:id/items/:itemId",
    dualWorkspaceAuth(),
    rateLimited,
    scoped("files:write"),
    removeGalleryItemHandler as unknown as MiddlewareHandler<DualAuthVars>,
  )
  .get(
    "/:workspace/galleries/:id/external-references",
    dualWorkspaceAuth(),
    scoped("files:read"),
    listExternalReferencesHandler as unknown as MiddlewareHandler<DualAuthVars>,
  )
  .post(
    "/:workspace/galleries/:id/external-references",
    dualWorkspaceAuth(),
    rateLimited,
    scoped("files:write"),
    addExternalReferenceHandler as unknown as MiddlewareHandler<DualAuthVars>,
  )
  .delete(
    "/:workspace/galleries/:id/external-references/:referenceId",
    dualWorkspaceAuth(),
    rateLimited,
    scoped("files:write"),
    removeExternalReferenceHandler as unknown as MiddlewareHandler<DualAuthVars>,
  )
  // `.fetch()`-ed directly by nothing today (galleries has no old-path
  // aliases folded through this router — see the module docblock), but this
  // still needs its own error boundary for consistency with the other
  // canonical verticals and in case a future alias does re-dispatch through
  // it directly.
  .onError((err, c) => respondError(c, err));
