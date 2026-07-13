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
import { Hono } from "hono";
import { usageWithLimits } from "../budget";
import { membershipsForUser, orgForWorkspace, workspacesForOrg } from "../org-workspaces";
import { requireSessionUser, sessionAuth, type SessionVars } from "../session-auth";
import { getWorkspaceUsage } from "../usage";
import { loadWorkspaceRecord } from "../workspace";

interface MyWorkspace {
  workspace: string;
  organization: { id: string; slug: string; name: string };
  role: string;
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
      });
    }
  }
  return out;
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
    const userId = c.get("sessionUser")?.id;
    if (!userId) throw new NotFoundError("workspace not found", { code: "workspace_not_found" });

    const workspaces = await myWorkspaces(c.env, userId);
    if (!workspaces.some((ws) => ws.workspace === name)) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }

    const record = await loadWorkspaceRecord(c.env, name);
    if (!record) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }

    const usage = await getWorkspaceUsage(c.env.DB, name);
    return c.json(usageWithLimits(usage, record));
  });
