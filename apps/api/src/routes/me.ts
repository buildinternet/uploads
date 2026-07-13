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
import { NotFoundError } from "@uploads/errors";
import { Hono, type Context } from "hono";
import { usageWithLimits } from "../budget";
import { listObjects } from "../files-core";
import { listGalleries } from "../galleries";
import { gallerySummary } from "../gallery-service";
import { membershipsForUser, orgForWorkspace, workspacesForOrg } from "../org-workspaces";
import { requireSessionUser, sessionAuth, type SessionVars } from "../session-auth";
import { getWorkspaceUsage } from "../usage";
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

  // Workspaces the caller belongs to, via their org memberships.
  .get("/workspaces", async (c) => {
    const userId = c.get("sessionUser")?.id;
    if (!userId) throw new NotFoundError("no session user", { code: "workspace_not_found" });
    const workspaces = await myWorkspaces(c.env, userId);
    return c.json({ workspaces });
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
  });
