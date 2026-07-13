/**
 * Session-authenticated, read-only usage surface for signed-in users (issue
 * #107 — follow-on to /admin-ui/*'s Phase 3 pattern). Gated by
 * `requireSessionUser` only — NOT `requireAdminUser` — so any signed-in user
 * can see their own workspace memberships and usage, not just admins.
 *
 * Authorization for `/workspaces/:name/usage` is the membership lookup
 * itself: a workspace not present in the caller's own memberships 404s
 * (`workspace_not_found`) rather than 403ing, so membership can't be probed
 * for workspace existence any more precisely than for any other workspace.
 */
import { NotFoundError, ValidationError } from "@uploads/errors";
import { createFilesRouter, signedDownloadUrl } from "@uploads/storage";
import { Hono, type Context } from "hono";
import { usageWithLimits } from "../budget";
import { badKey, listObjects, setObjectVisibility } from "../files-core";
import { listGalleries } from "../galleries";
import { gallerySummary } from "../gallery-service";
import { membershipsForUser, orgForWorkspace, workspacesForOrg } from "../org-workspaces";
import { requireSessionUser, sessionAuth, type SessionVars } from "../session-auth";
import { publicUrl, storage, storageConfig } from "../storage";
import { getWorkspaceUsage } from "../usage";
import { sanitizeVisibility, VISIBILITY_VALUES } from "../visibility";
import { loadWorkspaceRecord } from "../workspace";

interface MyWorkspace {
  workspace: string;
  organization: { id: string; slug: string; name: string };
  role: string;
  /** True for the communal, world-readable workspace (see isCommunal). */
  communal: boolean;
}

/**
 * The communal workspace — the shared public dumping ground — is identified by
 * name (the shared bucket hosts many prefixed workspaces, so the bucket can't
 * mark it). Configurable via the `DEFAULT_WORKSPACE` var; defaults to
 * "default". Member surfaces skip the personal galleries/files browser for it.
 */
function isCommunal(env: Env, name: string): boolean {
  return name === (env.DEFAULT_WORKSPACE || "default");
}

/**
 * Every workspace the user's memberships map to, one entry per (workspace,
 * membership) pair — `workspacesForOrg` never assumes slug === workspace
 * name directly, so this is a small fan-out rather than a 1:1 zip.
 */
async function myWorkspaces(env: Env, userId: string): Promise<MyWorkspace[]> {
  const memberships = await membershipsForUser(env, userId);
  const out: MyWorkspace[] = [];
  for (const membership of memberships) {
    const [org, names] = await Promise.all([
      orgForWorkspace(env, membership.organizationSlug),
      workspacesForOrg(env, membership.organizationSlug),
    ]);
    for (const workspace of names) {
      out.push({
        workspace,
        organization: org ?? {
          id: membership.organizationId,
          slug: membership.organizationSlug,
          name: membership.organizationSlug,
        },
        role: membership.role,
        communal: isCommunal(env, workspace),
      });
    }
  }
  return out;
}

/**
 * The caller's membership entry for `name`, or a uniform 404. Authorization for
 * every `/workspaces/:name/*` route is this lookup: a workspace absent from the
 * caller's memberships 404s (`workspace_not_found`) rather than 403ing, so
 * membership can't be probed for workspace existence.
 */
async function memberWorkspaceOr404(env: Env, userId: string, name: string): Promise<MyWorkspace> {
  const workspaces = await myWorkspaces(env, userId);
  const ws = workspaces.find((w) => w.workspace === name);
  if (!ws) throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
  return ws;
}

function requireUserId(c: Context<SessionVars>): string {
  // requireSessionUser guarantees a session user; the guard is belt-and-braces
  // and keeps the 404 (not 401) shape uniform with the not-a-member case.
  const userId = c.get("sessionUser")?.id;
  if (!userId) throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
  return userId;
}

export const me = new Hono<SessionVars>()
  .use("/*", sessionAuth, requireSessionUser)

  // Workspaces the caller belongs to, via their org memberships. `hasPublicUrl`
  // lets the account UI decide, per workspace, whether opening a file should
  // navigate to the public /f/ page (issue #135) or resolve through the
  // signed-URL-capable /file-url endpoint (issue #123) — see
  // apps/web's AccountFileBrowser. Loaded here (not in `myWorkspaces`, which
  // every member-gated route calls for authorization) so the extra KV read
  // per workspace stays confined to this one listing endpoint.
  .get("/workspaces", async (c) => {
    const userId = c.get("sessionUser")?.id;
    if (!userId) throw new NotFoundError("no session user", { code: "workspace_not_found" });
    const workspaces = await myWorkspaces(c.env, userId);
    const withPublicUrl = await Promise.all(
      workspaces.map(async (ws) => {
        const hasPublicUrl = ws.communal
          ? false
          : Boolean((await loadWorkspaceRecord(c.env, ws.workspace))?.publicBaseUrl);
        return Object.assign({}, ws, { hasPublicUrl });
      }),
    );
    return c.json({ workspaces: withPublicUrl });
  })

  // Usage + limits for one workspace — 404s unless the caller is a member.
  .get("/workspaces/:name/usage", async (c) => {
    const name = c.req.param("name");
    await memberWorkspaceOr404(c.env, requireUserId(c), name);

    const record = await loadWorkspaceRecord(c.env, name);
    if (!record) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }

    const usage = await getWorkspaceUsage(c.env.DB, name);
    return c.json(usageWithLimits(usage, record));
  })

  // Galleries in one workspace — member-gated. The communal workspace is a
  // shared public dumping ground, so we don't enumerate it here; the response
  // stays branch-free for clients with `communal: true` and an empty list.
  .get("/workspaces/:name/galleries", async (c) => {
    const name = c.req.param("name");
    const ws = await memberWorkspaceOr404(c.env, requireUserId(c), name);
    if (ws.communal) return c.json({ communal: true, galleries: [] });

    const page = await listGalleries(c.env.DB, name, { limit: 50 });
    return c.json({
      communal: false,
      galleries: page.galleries.map((gallery) => gallerySummary(c.env, gallery)),
    });
  })

  // A page of a workspace's files (public URLs) — member-gated. Skipped for the
  // communal workspace for the same reason as galleries; returns `communal:
  // true` with an empty list rather than listing the shared bucket to a member.
  .get("/workspaces/:name/files", async (c) => {
    const name = c.req.param("name");
    const ws = await memberWorkspaceOr404(c.env, requireUserId(c), name);
    if (ws.communal) return c.json({ communal: true, files: [] });

    const record = await loadWorkspaceRecord(c.env, name);
    if (!record) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }
    const { items } = await listObjects(c.env, record, { limit: 25 });
    return c.json({ communal: false, files: items });
  })

  // Resolve a selected browser item to a usable URL, by storage capability
  // (issue #123): the stable public URL when `publicBaseUrl` is configured;
  // otherwise a short-lived signed download URL when the provider can sign;
  // otherwise a typed error rather than a 200 with `url: null`. This is
  // separate from the gateway's `url` verb because its forced attachment
  // disposition requires signing, while binding-mode R2 uses publicBaseUrl.
  .get("/workspaces/:name/file-url", async (c) => {
    const name = c.req.param("name");
    const ws = await memberWorkspaceOr404(c.env, requireUserId(c), name);
    const key = c.req.query("key") ?? "";
    if (ws.communal || badKey(key)) throw new NotFoundError();
    const record = await loadWorkspaceRecord(c.env, name);
    if (!record) throw new NotFoundError();
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

  // Toggle a file's `visibility` custom-metadata flag — member-gated, same key
  // convention as `file-url` (key via query param; embedding it in the path
  // segment fights Hono's routing for keys containing `/`). Storage mechanics
  // (head/size-cap/download/re-upload) live in files-core's
  // `setObjectVisibility`; this route keeps auth, key validation, body
  // validation, and error mapping.
  .patch("/workspaces/:name/files/visibility", async (c) => {
    const name = c.req.param("name");
    const ws = await memberWorkspaceOr404(c.env, requireUserId(c), name);
    const key = c.req.query("key") ?? "";
    if (ws.communal || badKey(key)) throw new NotFoundError();

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

    const record = await loadWorkspaceRecord(c.env, name);
    if (!record) throw new NotFoundError();
    const store = await storage(c.env, record);

    await setObjectVisibility(store, key, requested as "public" | "private");

    return c.json({ key, visibility: sanitizeVisibility(requested) ?? "public" });
  })

  // files-sdk's folder-aware browser gateway. Authorization happens before a
  // storage instance is constructed; readonly plus this operation allow-list
  // independently prevent member UI requests from mutating storage.
  .all("/workspaces/:name/file-browser", async (c) => {
    const name = c.req.param("name");
    const ws = await memberWorkspaceOr404(c.env, requireUserId(c), name);
    if (ws.communal) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }
    const record = await loadWorkspaceRecord(c.env, name);
    if (!record) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }
    const router = createFilesRouter({
      files: (await storage(c.env, record)).readonly(),
      operations: ["list"],
      maxListLimit: 100,
      // files-sdk resolves a signing secret even when signing operations are
      // disabled. This value is intentionally non-secret and cannot authorize
      // anything on this list-only, authenticated gateway.
      secret: `readonly-list:${name}`,
    });
    return router.handle(c.req.raw);
  });
