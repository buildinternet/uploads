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
 *  - `GET /members`, `GET /people` — **session-only**: any member. An
 *    `up_`-shaped bearer credential 403s `members_requires_session` — there
 *    is no bearer scope that grants "read the roster" today and this PR
 *    mints no new one. A non-`up_` bearer (a Better Auth session token, no
 *    cookie) is not a workspace-token shape and is instead handed to session
 *    resolution, same as a cookie — see `sessionMemberGate`'s docblock
 *    (issue #613 phase 3 review finding 1). The `people` response hides
 *    `invites` from non-managers, preserved verbatim from the pre-#613 `/me`
 *    handler this was extracted from.
 *  - `GET /invites`, `DELETE /invites/:id`, `DELETE /members/:memberId`,
 *    `PATCH /members/:memberId` — **session-only**, admin/owner-gated. Same
 *    bearer posture as above (same `members_requires_session` code for an
 *    `up_`-shaped bearer) — no bearer capability for list/revoke/remove/
 *    role-change existed before this PR and none is added.
 *  - `POST /invites` is NOT here — it is the one route in this vertical with
 *    a genuine pre-existing bearer capability (`workspace:invite` governance
 *    token), so it stays where it already lived at the canonical path
 *    convention: `routes/workspaces.ts`'s `POST /:name/invites`, upgraded in
 *    place to `dualGovernanceAuth("workspace:invite")`. Registering a second
 *    `POST /:workspace/invites` here would double-register/shadow that exact
 *    path — see that route's docblock for the "upgrade in place, don't
 *    parallel-register" reasoning.
 *  - `POST /invite-links`, `GET /invite-links`, `DELETE /invite-links/:id`
 *    (issue #869 phase B) — session-only, admin/owner-gated, same as the
 *    email-invite routes above. Mint/list/revoke a `kind: 'member'`
 *    `auth_enrollments` row: redeeming one (`POST /auth/enrollments/join` in
 *    `routes/auth.ts`) adds the redeemer as an org member, member-cap
 *    enforced at both mint and redemption. Distinct from the pre-existing
 *    `kind: 'token'` invite links `/admin` mints for CLI onboarding (`POST
 *    /admin-ui/workspaces/:name/invite-links`, `routes/admin-ui.ts`) — same
 *    `auth_enrollments` table and `auth-db.ts` helpers, filtered by `kind` so
 *    neither surface can list or revoke the other's links.
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
import {
  createEnrollment,
  DEFAULT_MEMBER_LINK_SECONDS,
  DEFAULT_TOKEN_SECONDS,
  labelValue,
  listOpenEnrollments,
  MAX_MEMBER_LINK_SECONDS,
  MIN_MEMBER_LINK_SECONDS,
  revokeEnrollment,
} from "../auth-db";
import { dbFor } from "../db-session";
import { hasPreresolvedSession, resolveSessionUserId } from "../dual-workspace-auth";
import { respondError } from "../error-response";
import { allowWrite } from "../guards";
import { throwForInviteError } from "../invite-error";
import { deriveWebOrigin, inviteLinkUrl } from "../invite-links";
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
import { isPurgedTombstone, loadWorkspaceRecordRaw } from "../workspace";

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

/**
 * Wire types for this vertical's responses (issue #896 pattern), inferred
 * from the serializers/rows the handlers actually send so apps/web
 * (`src/lib/api-client.ts`, via `@uploads/api/workspace-members`) imports the
 * shape it receives instead of re-declaring it. Type-only — nothing here is
 * imported at runtime across workers.
 */
export type WorkspaceMemberRow = ReturnType<typeof projectMembers>[number];
/** `GET /:workspace/invites` rows — the auth worker's pending-invite projection. */
export type { OrgInvite } from "../org-workspaces";
/** `GET /:workspace/invite-links` rows — open `kind: 'member'` enrollments. */
export type { OpenEnrollment } from "../auth-db";
/** `POST /:workspace/invite-links` 201 body. */
export type InviteLinkMintResponse = ReturnType<typeof inviteLinkMintResponse>;

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
 * Session-only member gate: an `up_`-shaped bearer `Authorization` header
 * 403s outright (no governance-token fallback — this vertical mints no
 * read/list/manage bearer capability in this PR), otherwise resolves the
 * session + membership with a uniform 404 for non-members (never a 403 — no
 * existence probe, same posture as `dualWorkspaceAuth`/`dualGovernanceAuth`).
 *
 * Bearer discrimination (issue #613 phase 3 review finding 1): a preset
 * (`hasPreresolvedSession`, e.g. a forwarded `/me` request whose session
 * `me.ts` already validated via its own `sessionAuth`) always wins,
 * unconditionally, BEFORE ever looking at the `Authorization` header — a
 * forwarded request keeps its original headers verbatim, so a caller who
 * authenticated to `/me` with a Better Auth bearer session (no cookie) must
 * not be rejected a second time here. Absent a preset, only an `up_`-shaped
 * bearer is rejected as "wrong credential type" — the same `up_`-prefix
 * discrimination `workspaceManageAuth` (`routes/workspaces.ts`) and
 * `dualGovernanceAuth` use to tell a workspace/governance token apart from a
 * Better Auth bearer session riding the same header. Any other bearer (or
 * none) falls through to `resolveSessionUserId`, which forwards the
 * `Authorization` header to `get-session` as-is and validates a Better Auth
 * session bearer exactly like a cookie.
 */
function sessionMemberGate(): MiddlewareHandler<MembersVars> {
  return async (c, next) => {
    const authorization = c.req.header("Authorization");
    const rawToken = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    if (!hasPreresolvedSession(c.req.raw) && rawToken?.startsWith("up_")) {
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

/**
 * 404s minting a member-kind invite link for a soft-deleted or
 * purged-tombstone workspace — same existence rule `loadEditableWorkspace`
 * (`routes/admin-ui.ts`) applies to the admin-minted token-kind links. Mint
 * only: list/revoke stay unguarded here, since seeing or clearing out
 * outstanding links during a deletion grace period is still legitimately
 * useful (and `sessionAdminGate` already means the caller was a member of a
 * workspace that still exists in the membership lookup at some point).
 */
async function requireLiveWorkspace(env: Env, name: string): Promise<void> {
  const record = await loadWorkspaceRecordRaw(env, name);
  if (!record || isPurgedTombstone(record) || record.deletedAt) {
    throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
  }
}

/**
 * Validates the mint body's `expiresIn` (issue #876): `undefined` → caller
 * applies `DEFAULT_MEMBER_LINK_SECONDS`; `"never"` or `null` → non-expiring
 * (`createEnrollment`'s `enrollmentSeconds: null`); a positive integer
 * within `[MIN_MEMBER_LINK_SECONDS, MAX_MEMBER_LINK_SECONDS]` → that many
 * seconds. Anything else (a string other than `"never"`, a non-integer, an
 * out-of-range number) is `{ ok: false }`.
 */
function validExpiresIn(
  value: unknown,
): { ok: true; value: number | null | undefined } | { ok: false } {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null || value === "never") return { ok: true, value: null };
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_MEMBER_LINK_SECONDS &&
    value <= MAX_MEMBER_LINK_SECONDS
  ) {
    return { ok: true, value };
  }
  return { ok: false };
}

/** Validates the mint body's `maxUses`: `undefined`/`null` → unlimited; a positive integer → that cap. */
function validMaxUses(value: unknown): { ok: true; value: number | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) {
    return { ok: true, value };
  }
  return { ok: false };
}

/**
 * `sessionAdminGate`'s `MembersVars["memberOrg"]["slug"]` IS the workspace
 * name (the 1:1 org<->workspace mapping `org-workspaces.ts` documents), so
 * every invite-link handler below reuses it instead of re-reading (and
 * re-widening) the `:workspace` path param — same pattern as
 * `inviteRevokeHandler`'s `allowWrite(c.env, org.slug)` call above.
 *
 * `POST /:workspace/invite-links` — mint a `kind: 'member'` invite link
 * (issue #869 phase B). Its redemption (`POST /auth/enrollments/join`) adds
 * the redeemer as an org member with role `member`, never a CLI token — so
 * this route mints with `scopes: []` (never used by a member-kind exchange;
 * `exchangeEnrollment` rejects non-'token' rows outright regardless) and
 * checks the member cap at mint time, mirroring email invites' `POST
 * /:workspace/invites` (`routes/workspaces.ts`): same `member_cap_reached`
 * error shape via `throwForInviteError`, same fail-open posture on a cap
 * lookup that can't be made (`memberCapDenial` in apps/auth). Redemption
 * re-checks the cap independently — see `routes/auth.ts`'s join handler.
 */
export async function inviteLinkMintHandler(c: Context<MembersVars>) {
  const org = c.get("memberOrg");
  if (!(await allowWrite(c.env, org.slug))) throw new RateLimitedError("rate limit exceeded");

  // requireLiveWorkspace (KV) and the AUTH member-cap-check fetch are
  // independent lookups with no data dependency on each other — start both
  // before awaiting either so their latencies overlap. requireLiveWorkspace
  // is still awaited (and can still throw 404) before the label is
  // validated and before the cap-check result is inspected, preserving
  // today's precedence: not-found, then invalid label, then cap denial.
  const liveWorkspace = requireLiveWorkspace(c.env, org.slug);
  const capCheckFetch = c.env.AUTH.fetch("https://auth.internal/internal/member-cap/check", {
    method: "POST",
    headers: { "content-type": "application/json", "x-uploads-internal": "1" },
    body: JSON.stringify({ workspace: org.slug }),
  });
  await liveWorkspace;

  const body = await c.req
    .json<{ label?: unknown; expiresIn?: unknown; maxUses?: unknown }>()
    .catch(() => ({}) as { label?: unknown; expiresIn?: unknown; maxUses?: unknown });
  const label = labelValue(body.label);
  if (label === null) {
    throw new ValidationError("label must be between 1 and 100 characters", {
      code: "invalid_label",
    });
  }
  const expiresIn = validExpiresIn(body.expiresIn);
  if (!expiresIn.ok) {
    throw new ValidationError(
      `expiresIn must be "never", null, or an integer number of seconds between ` +
        `${MIN_MEMBER_LINK_SECONDS} and ${MAX_MEMBER_LINK_SECONDS}`,
      { code: "invalid_expires_in" },
    );
  }
  const maxUses = validMaxUses(body.maxUses);
  if (!maxUses.ok) {
    throw new ValidationError("maxUses must be null or a positive integer", {
      code: "invalid_max_uses",
    });
  }

  const capCheck = await capCheckFetch;
  if (!capCheck.ok) {
    const payload = await capCheck.json().catch(() => null);
    throwForInviteError(capCheck.status, payload);
  }

  const enrollment = await createEnrollment(dbFor(c.env), {
    workspace: org.slug,
    label,
    scopes: [],
    kind: "member",
    enrollmentSeconds:
      expiresIn.value === undefined ? DEFAULT_MEMBER_LINK_SECONDS : expiresIn.value,
    tokenSeconds: DEFAULT_TOKEN_SECONDS,
    maxUses: maxUses.value,
  });

  const webOrigin = c.env.WEB_ORIGIN || deriveWebOrigin(c.req.url);
  const url = inviteLinkUrl(webOrigin, enrollment.pageId, enrollment.code);

  return c.json(inviteLinkMintResponse(org.slug, enrollment, label, url, maxUses.value), 201);
}

/** The `POST /:workspace/invite-links` 201 body — the minted link, URL included (show-once). */
function inviteLinkMintResponse(
  workspace: string,
  enrollment: { id: string; pageId: string | null; expiresAt: string | null },
  label: string | undefined,
  url: string,
  maxUses: number | null,
) {
  return {
    workspace,
    id: enrollment.id,
    pageId: enrollment.pageId,
    label: label ?? null,
    url,
    expiresAt: enrollment.expiresAt,
    maxUses,
    useCount: 0,
  };
}

/** `GET /:workspace/invite-links` — outstanding `kind: 'member'` links only;
 * never the plaintext code or its hash (show-once stays show-once). */
export async function inviteLinkListHandler(c: Context<MembersVars>) {
  const org = c.get("memberOrg");
  const links = await listOpenEnrollments(dbFor(c.env), org.slug, new Date(), "member");
  return c.json({ links });
}

/** `DELETE /:workspace/invite-links/:id` — revoke one outstanding
 * `kind: 'member'` link before it's redeemed; the `kind` filter means this
 * can never revoke a token-kind link minted from `/admin`. */
export async function inviteLinkRevokeHandler(c: Context<MembersVars>) {
  const org = c.get("memberOrg");
  if (!(await allowWrite(c.env, org.slug))) throw new RateLimitedError("rate limit exceeded");
  const id = c.req.param("id") ?? "";
  const revoked = await revokeEnrollment(dbFor(c.env), org.slug, id, "member");
  if (!revoked) {
    throw new NotFoundError("invite link not found", { code: "invite_link_not_found" });
  }
  return c.json({ ok: true, id });
}

export const workspaceMembers = new Hono<MembersVars>()
  .get("/:workspace/members", sessionMemberGate(), membersHandler)
  .get("/:workspace/people", sessionMemberGate(), peopleHandler)
  .get("/:workspace/invites", sessionAdminGate(), invitesListHandler)
  .delete("/:workspace/invites/:id", sessionAdminGate(), inviteRevokeHandler)
  .delete("/:workspace/members/:memberId", sessionAdminGate(), memberRemoveHandler)
  .patch("/:workspace/members/:memberId", sessionAdminGate(), memberRoleUpdateHandler)
  .post("/:workspace/invite-links", sessionAdminGate(), inviteLinkMintHandler)
  .get("/:workspace/invite-links", sessionAdminGate(), inviteLinkListHandler)
  .delete("/:workspace/invite-links/:id", sessionAdminGate(), inviteLinkRevokeHandler)
  .onError((err, c) => respondError(c, err));
