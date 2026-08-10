/**
 * Canonical invites/members vertical (issue #613 phase 3):
 * `/:workspace/members`, `/:workspace/people`, `/:workspace/invites*`,
 * `/:workspace/members/:memberId*`, mounted at `/v1/workspaces` in
 * `index.ts` so its public paths are `/v1/workspaces/:workspace/...`. Same
 * self-contained-router shape as `workspace-github.ts`/`workspace-usage.ts`:
 * own auth, own `.onError()`, `.fetch()`-able directly by an alias with no
 * parent-mount dependency for its `:workspace` param.
 *
 * Posture (`.context/613-api-consolidation-plan.md`, "invites / members"):
 *
 *  - `GET /members`, `GET /people` — **session-only**: any member. A bearer
 *    credential 403s `members_requires_session` — there is no bearer scope
 *    that grants "read the roster" today and this PR mints no new one. The
 *    `people` response hides `invites` from non-managers, preserved verbatim
 *    from the pre-#613 `/me` handler this was extracted from.
 *  - `GET /invites`, `DELETE /invites/:id`, `DELETE /members/:memberId`,
 *    `PATCH /members/:memberId` — **session-only**, admin/owner-gated. Same
 *    bearer-403 posture as above (same `members_requires_session` code) —
 *    no bearer capability for list/revoke/remove/role-change existed before
 *    this PR and none is added.
 *  - `POST /invites` is NOT here — it is the one route in this vertical with
 *    a genuine pre-existing bearer capability (`workspace:invite` governance
 *    token), so it stays where it already lived at the canonical path
 *    convention: `routes/workspaces.ts`'s `POST /:name/invites`, upgraded in
 *    place to `dualGovernanceAuth("workspace:invite")`. Registering a second
 *    `POST /:workspace/invites` here would double-register/shadow that exact
 *    path — see that route's docblock for the "upgrade in place, don't
 *    parallel-register" reasoning.
 *
 * Session auth here is session-only-with-admin-tier, NOT
 * `dualWorkspaceAuth`/`requireSessionAdmin` (those grant a session caller
 * file-plane `FILE_SCOPES`, meaningless for this vertical) and NOT
 * `dualGovernanceAuth` (that accepts a bearer governance token, which none of
 * these routes should — no new bearer capability). Deliberately a small
 * local guard instead, reusing `resolveSessionUserId` from
 * `dual-workspace-auth.ts` for the same "one get-session call per forwarded
 * request" property every other vertical gets from the WeakMap handoff.
 */
import { ForbiddenError, NotFoundError, RateLimitedError, ValidationError } from "@uploads/errors";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { resolveSessionUserId } from "../dual-workspace-auth";
import { respondError } from "../error-response";
import { allowWrite } from "../guards";
import {
  invitesForOrg,
  membersForOrg,
  membershipsForUser,
  removeMember,
  revokeInvite,
  updateMemberRole,
  workspacesFromMembership,
  type OrgMember,
} from "../org-workspaces";
import type { SessionVars } from "../session-auth";

/** Context vars a `sessionMemberGate`/`sessionAdminGate`-guarded route can rely on. */
export type MembersVars = {
  Variables: SessionVars["Variables"] & {
    memberOrg: { id: string; slug: string; name: string };
    memberRole: string;
  };
  Bindings: Env;
};

function canManageRole(role: string): boolean {
  return role === "admin" || role === "owner";
}

/** Sanitize org members for the account people UI (opaque `id` only for managers). */
function projectMembers(members: OrgMember[], canManage: boolean) {
  return members.map((m) => {
    const row: {
      id?: string;
      email: string;
      name: string;
      role: string;
      createdAt?: string;
    } = {
      email: m.email ?? "",
      name: m.name ?? "",
      role: m.role ?? "member",
      createdAt: m.createdAt,
    };
    if (canManage) row.id = m.id;
    return row;
  });
}

/**
 * Session-only member gate: a bearer `Authorization` header 403s outright
 * (no governance-token fallback — this vertical mints no read/list/manage
 * bearer capability in this PR), otherwise resolves the session + membership
 * with a uniform 404 for non-members (never a 403 — no existence probe, same
 * posture as `dualWorkspaceAuth`/`dualGovernanceAuth`).
 */
function sessionMemberGate(): MiddlewareHandler<MembersVars> {
  return async (c, next) => {
    if (c.req.header("Authorization")?.startsWith("Bearer ")) {
      throw new ForbiddenError("requires a session", { code: "members_requires_session" });
    }
    const userId = await resolveSessionUserId(c as unknown as Context<SessionVars>);
    const name = c.req.param("workspace");
    if (!name) throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    const [membership] = await membershipsForUser(c.env, userId, { slug: name });
    if (!membership || !workspacesFromMembership(membership).includes(name)) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }
    c.set("memberOrg", {
      id: membership.organizationId,
      slug: membership.organizationSlug,
      name: membership.organizationName || membership.organizationSlug,
    });
    c.set("memberRole", membership.role);
    await next();
  };
}

/** `sessionMemberGate` plus an admin/owner role requirement — 403 for a member who isn't. */
function sessionAdminGate(): MiddlewareHandler<MembersVars> {
  const memberGate = sessionMemberGate();
  return async (c, next) => {
    await memberGate(c, async () => {
      if (!canManageRole(c.get("memberRole"))) {
        throw new ForbiddenError("workspace admin or owner role required", {
          code: "workspace_admin_required",
        });
      }
      await next();
    });
  };
}

/** `GET /:workspace/members` — member-gated; teammate fields only, not admin raw rows. */
export async function membersHandler(c: Context<MembersVars>) {
  const org = c.get("memberOrg");
  const canManage = canManageRole(c.get("memberRole"));
  const members = await membersForOrg(c.env, org.slug);
  return c.json({ members: projectMembers(members, canManage) });
}

/** `GET /:workspace/people` — members + (for admins) pending invites + role, one authz pass. */
export async function peopleHandler(c: Context<MembersVars>) {
  const org = c.get("memberOrg");
  const role = c.get("memberRole");
  const canManage = canManageRole(role);
  const [members, invites] = await Promise.all([
    membersForOrg(c.env, org.slug),
    canManage ? invitesForOrg(c.env, org.slug) : Promise.resolve([]),
  ]);
  return c.json({
    role,
    canManage,
    organization: org,
    members: projectMembers(members, canManage),
    invites: canManage ? invites : [],
  });
}

/** `GET /:workspace/invites` — pending invites; admin/owner only (they can revoke). */
export async function invitesListHandler(c: Context<MembersVars>) {
  const org = c.get("memberOrg");
  const invites = await invitesForOrg(c.env, org.slug);
  return c.json({ invites });
}

/** `DELETE /:workspace/invites/:id` — revoke a pending invite; admin/owner only. */
export async function inviteRevokeHandler(c: Context<MembersVars>) {
  const org = c.get("memberOrg");
  const userId = await resolveSessionUserId(c as unknown as Context<SessionVars>);
  // `allowWrite` is keyed on workspace name; `org.slug` IS the workspace name
  // (the 1:1 mapping `org-workspaces.ts` documents), already resolved by
  // `sessionAdminGate` — reusing it here avoids re-reading (and re-widening)
  // the `:workspace` path param.
  if (!(await allowWrite(c.env, org.slug))) throw new RateLimitedError("rate limit exceeded");
  // `:id` is a required route segment — Hono guarantees it on a matched
  // route; the `?? ""` is a typing formality only (`Context<MembersVars>`
  // doesn't carry the literal path, so `param()` can't be narrowed the way
  // it would be for a handler declared inline on the route).
  await revokeInvite(c.env, org.slug, c.req.param("id") ?? "", userId);
  return c.json({ ok: true });
}

/** `DELETE /:workspace/members/:memberId` — remove a member; admin/owner only. */
export async function memberRemoveHandler(c: Context<MembersVars>) {
  const org = c.get("memberOrg");
  const userId = await resolveSessionUserId(c as unknown as Context<SessionVars>);
  if (!(await allowWrite(c.env, org.slug))) throw new RateLimitedError("rate limit exceeded");
  await removeMember(c.env, org.slug, c.req.param("memberId") ?? "", userId);
  return c.json({ ok: true });
}

/** `PATCH /:workspace/members/:memberId` — change a member's role; admin/owner only. */
export async function memberRoleUpdateHandler(c: Context<MembersVars>) {
  const org = c.get("memberOrg");
  const userId = await resolveSessionUserId(c as unknown as Context<SessionVars>);
  if (!(await allowWrite(c.env, org.slug))) throw new RateLimitedError("rate limit exceeded");
  const body = await c.req.json<{ role?: unknown }>().catch(() => ({}) as { role?: unknown });
  const role = typeof body.role === "string" ? body.role.trim() : "";
  if (role !== "admin" && role !== "member") {
    throw new ValidationError("role must be admin or member", { code: "invalid_role" });
  }
  const member = await updateMemberRole(
    c.env,
    org.slug,
    c.req.param("memberId") ?? "",
    role,
    userId,
  );
  return c.json({ member });
}

export const workspaceMembers = new Hono<MembersVars>()
  .get("/:workspace/members", sessionMemberGate(), membersHandler)
  .get("/:workspace/people", sessionMemberGate(), peopleHandler)
  .get("/:workspace/invites", sessionAdminGate(), invitesListHandler)
  .delete("/:workspace/invites/:id", sessionAdminGate(), inviteRevokeHandler)
  .delete("/:workspace/members/:memberId", sessionAdminGate(), memberRemoveHandler)
  .patch("/:workspace/members/:memberId", sessionAdminGate(), memberRoleUpdateHandler)
  .onError((err, c) => respondError(c, err));
