/**
 * Org <-> workspace indirection (plan D4, Phase 3).
 *
 * Today an "org" (a Better Auth `organization` row, owned by the auth
 * worker's D1) maps 1:1 onto a "workspace" (a KV `ws:<name>` record, owned by
 * this worker) by `organization.slug === workspace name`. That 1:1 mapping is
 * an implementation detail of this module only — every other org<->workspace
 * lookup in apps/api MUST go through `orgForWorkspace`/`workspacesForOrg`
 * rather than assuming the slug equals the workspace name directly. If a
 * future org ever owns more than one workspace, this module is the only file
 * that needs to change (e.g. to consult a join table instead of doing a
 * pass-through slug lookup) — callers keep working unmodified.
 *
 * All lookups go through the `AUTH` service binding's internal API (never a
 * direct D1 read — this worker has no D1 binding into the auth worker's
 * database, by design, see plan D1's "ownership boundary").
 */

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from "@uploads/errors";

export interface OrgSummary {
  id: string;
  slug: string;
  name: string;
}

export interface Membership {
  organizationId: string;
  organizationSlug: string;
  role: string;
}

const INTERNAL_ORIGIN = "https://auth.internal";

function internalHeaders(): Headers {
  return new Headers({ "x-uploads-internal": "1" });
}

/**
 * A user's org memberships via `GET /internal/memberships?userId=` over the
 * AUTH binding. Like `orgForWorkspace`, a non-ok (or malformed) response is an
 * auth-worker outage/bug — surfaced as a 5xx — NOT "this user has no
 * memberships", so an outage can never masquerade as lost access. A user with
 * genuinely no memberships gets a 200 with `[]`. Shared by the session-auth
 * surfaces that need it (src/routes/me.ts, src/routes/tokens.ts).
 */
export async function membershipsForUser(env: Env, userId: string): Promise<Membership[]> {
  const response = await env.AUTH.fetch(
    `${INTERNAL_ORIGIN}/internal/memberships?userId=${encodeURIComponent(userId)}`,
    { headers: internalHeaders() },
  );
  if (!response.ok) {
    throw new ServiceUnavailableError("auth service returned an unexpected status", {
      code: "auth_lookup_failed",
      details: { status: response.status },
    });
  }
  const body = await response.json().catch(() => null);
  if (!Array.isArray(body)) {
    throw new ServiceUnavailableError("auth service returned a malformed body", {
      code: "auth_lookup_failed",
    });
  }
  return body as Membership[];
}

/** A raw member row from the auth worker's `/internal/orgs/:slug/members`. */
export interface OrgMember {
  id: string;
  userId: string;
  email: string;
  name: string | null;
  role: string;
  createdAt?: string;
}

/**
 * Members of an org via `GET /internal/orgs/:slug/members` over the AUTH
 * binding. Non-ok is an auth-worker outage/bug, surfaced as a 5xx like the
 * lookups above. Shared by the admin panel (raw rows) and the member-facing
 * people tab (which sanitizes before responding).
 */
export async function membersForOrg(env: Env, slug: string): Promise<OrgMember[]> {
  const response = await env.AUTH.fetch(
    `${INTERNAL_ORIGIN}/internal/orgs/${encodeURIComponent(slug)}/members`,
    { headers: internalHeaders() },
  );
  if (!response.ok) {
    throw new ServiceUnavailableError("auth service returned an unexpected status", {
      code: "auth_lookup_failed",
      details: { status: response.status },
    });
  }
  const body = (await response.json().catch(() => null)) as { members?: OrgMember[] } | null;
  return body?.members ?? [];
}

/** A pending invite row from `/internal/orgs/:slug/invites`. */
export interface OrgInvite {
  id: string;
  email: string;
  role: string | null;
  status: string;
  expiresAt: string | number | null;
}

/** Pending invites for an org. Non-ok is an auth-worker outage/bug (5xx), like the reads above. */
export async function invitesForOrg(env: Env, slug: string): Promise<OrgInvite[]> {
  const response = await env.AUTH.fetch(
    `${INTERNAL_ORIGIN}/internal/orgs/${encodeURIComponent(slug)}/invites`,
    { headers: internalHeaders() },
  );
  if (!response.ok) {
    throw new ServiceUnavailableError("auth service returned an unexpected status", {
      code: "auth_lookup_failed",
      details: { status: response.status },
    });
  }
  const body = (await response.json().catch(() => null)) as { invites?: OrgInvite[] } | null;
  return body?.invites ?? [];
}

/**
 * Maps the auth worker's authorization/validation failures to AppErrors. 403 →
 * Forbidden, 404 → NotFound, 400 → Validation; anything else is treated as an
 * outage. Shared by revoke/remove/role helpers below.
 */
async function throwForManageError(response: Response, context: string): Promise<never> {
  const body = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
  const code = body?.error?.code;
  if (response.status === 403) throw new ForbiddenError(context, { code: code ?? "forbidden" });
  if (response.status === 404) throw new NotFoundError(context, { code: code ?? "not_found" });
  if (response.status === 400)
    throw new ValidationError(context, { code: code ?? "invalid_request" });
  throw new ServiceUnavailableError("auth service returned an unexpected status", {
    code: "auth_lookup_failed",
    details: { status: response.status },
  });
}

/** Revoke a pending invite. `actorUserId` is the acting session user (authz). */
export async function revokeInvite(
  env: Env,
  slug: string,
  inviteId: string,
  actorUserId: string,
): Promise<void> {
  const url = `${INTERNAL_ORIGIN}/internal/orgs/${encodeURIComponent(slug)}/invites/${encodeURIComponent(inviteId)}?actorUserId=${encodeURIComponent(actorUserId)}`;
  const response = await env.AUTH.fetch(url, { method: "DELETE", headers: internalHeaders() });
  if (!response.ok) await throwForManageError(response, "could not revoke invite");
}

/** Remove a member (by opaque member id). `actorUserId` is the acting session user. */
export async function removeMember(
  env: Env,
  slug: string,
  memberId: string,
  actorUserId: string,
): Promise<void> {
  const url = `${INTERNAL_ORIGIN}/internal/orgs/${encodeURIComponent(slug)}/members/${encodeURIComponent(memberId)}?actorUserId=${encodeURIComponent(actorUserId)}`;
  const response = await env.AUTH.fetch(url, { method: "DELETE", headers: internalHeaders() });
  if (!response.ok) await throwForManageError(response, "could not remove member");
}

/** Change a member's role (admin↔member). Returns the updated member. */
export async function updateMemberRole(
  env: Env,
  slug: string,
  memberId: string,
  role: string,
  actorUserId: string,
): Promise<{ id: string; userId: string; role: string }> {
  const headers = internalHeaders();
  headers.set("content-type", "application/json");
  const response = await env.AUTH.fetch(
    `${INTERNAL_ORIGIN}/internal/orgs/${encodeURIComponent(slug)}/members/${encodeURIComponent(memberId)}`,
    { method: "PATCH", headers, body: JSON.stringify({ actorUserId, role }) },
  );
  if (!response.ok) await throwForManageError(response, "could not change member role");
  const body = (await response.json().catch(() => null)) as {
    member?: { id: string; userId: string; role: string };
  } | null;
  if (!body?.member) {
    throw new ServiceUnavailableError("auth service returned a malformed body", {
      code: "auth_lookup_failed",
    });
  }
  return body.member;
}

/**
 * The organization for a given workspace name, or null if none exists yet
 * (e.g. the workspace predates the Phase 3 backfill, or was never
 * provisioned as an org). Today: `GET /internal/orgs/:slug` with
 * `slug = workspace name`.
 */
export async function orgForWorkspace(env: Env, workspaceName: string): Promise<OrgSummary | null> {
  const response = await env.AUTH.fetch(
    `${INTERNAL_ORIGIN}/internal/orgs/${encodeURIComponent(workspaceName)}`,
    { headers: internalHeaders() },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    // Any other non-ok status is an outage/bug in the auth worker, not "no
    // org for this workspace" — throw so it surfaces as a 5xx via the API's
    // error middleware instead of silently masquerading as org_not_found.
    throw new ServiceUnavailableError("auth service returned an unexpected status", {
      code: "auth_lookup_failed",
      details: { status: response.status },
    });
  }
  const body = (await response.json().catch(() => null)) as { organization?: OrgSummary } | null;
  return body?.organization ?? null;
}

/**
 * Workspace names an org grants access to. Today: exactly `[org.slug]` (1:1)
 * — this is intentionally NOT `[orgIdOrSlug]` verbatim, since the input may
 * be an id; resolving through the org record keeps the contract stable if
 * the mapping ever becomes one-to-many.
 */
export async function workspacesForOrg(env: Env, orgIdOrSlug: string): Promise<string[]> {
  // Today's org records are looked up by slug on the auth worker; when the
  // input is already a slug this is a single round trip. If a caller passes
  // an id instead, this still resolves via the same endpoint since
  // organization.slug is unique and ids/slugs never collide in this schema —
  // callers of this module should prefer passing the slug they already have.
  const org = await orgForWorkspace(env, orgIdOrSlug);
  return org ? [org.slug] : [];
}

/** Self-serve org provisioning (spec 2026-07-14): org + owner member in one call. */
export async function provisionOrg(
  env: Env,
  args: { slug: string; name?: string; ownerUserId: string },
): Promise<OrgSummary> {
  const headers = internalHeaders();
  headers.set("content-type", "application/json");
  const response = await env.AUTH.fetch(`${INTERNAL_ORIGIN}/internal/orgs/provision`, {
    method: "POST",
    headers,
    body: JSON.stringify(args),
  });
  if (response.status === 409) {
    throw new ConflictError("workspace name is taken", { code: "workspace_name_taken" });
  }
  const body = (await response.json().catch(() => null)) as { organization?: OrgSummary } | null;
  if (!response.ok || !body?.organization) {
    throw new ServiceUnavailableError("auth service failed to provision the organization", {
      code: "auth_lookup_failed",
      details: { status: response.status },
    });
  }
  return body.organization;
}

/**
 * Compensating delete for provisionOrg (self-serve rollback, workspace
 * teardown) and, with `force: true`, the #250 orphan-org sweep's own hard
 * delete of a multi-member org left behind by a hard/finalized workspace
 * teardown. Best-effort: callers catch failures.
 */
export async function deleteOrg(env: Env, slug: string, opts?: { force?: boolean }): Promise<void> {
  const url = new URL(`${INTERNAL_ORIGIN}/internal/orgs/${encodeURIComponent(slug)}`);
  if (opts?.force) url.searchParams.set("force", "1");
  const response = await env.AUTH.fetch(url, {
    method: "DELETE",
    headers: internalHeaders(),
  });
  // 404 = already gone, which is what every caller wants (idempotent). Any
  // other failure must surface — the sweep records it as an error instead of
  // reporting the org deleted, and best-effort callers .catch as before.
  if (!response.ok && response.status !== 404) {
    throw new ServiceUnavailableError("auth service failed to delete the organization", {
      code: "auth_lookup_failed",
      details: { status: response.status, slug },
    });
  }
}

/** Minimal org identity — just enough for the #250 orphan sweep to cross-reference slugs. */
export interface OrgSlug {
  id: string;
  slug: string;
  /** ISO timestamp; lets the sweep skip orgs still inside the provisioning window. */
  createdAt?: string | null;
}

/**
 * Every auth-side org slug (id+slug only) — used by the #250 orphan sweep to
 * cross-reference against `ws:<slug>` KV keys. A non-ok response is an
 * auth-worker outage/bug, surfaced as a 5xx like the rest of this module.
 */
export async function listOrgs(env: Env): Promise<OrgSlug[]> {
  const response = await env.AUTH.fetch(`${INTERNAL_ORIGIN}/internal/orgs`, {
    headers: internalHeaders(),
  });
  if (!response.ok) {
    throw new ServiceUnavailableError("auth service returned an unexpected status", {
      code: "auth_lookup_failed",
      details: { status: response.status },
    });
  }
  const body = (await response.json().catch(() => null)) as { organizations?: OrgSlug[] } | null;
  if (!body || !Array.isArray(body.organizations)) {
    throw new ServiceUnavailableError("auth service returned a malformed body", {
      code: "auth_lookup_failed",
    });
  }
  return body.organizations;
}

/** Whether the user has a linked GitHub account (self-serve gate). */
export async function isGithubLinked(env: Env, userId: string): Promise<boolean> {
  const response = await env.AUTH.fetch(
    `${INTERNAL_ORIGIN}/internal/users/${encodeURIComponent(userId)}/github-linked`,
    { headers: internalHeaders() },
  );
  if (!response.ok) {
    throw new ServiceUnavailableError("auth service returned an unexpected status", {
      code: "auth_lookup_failed",
      details: { status: response.status },
    });
  }
  const body = (await response.json().catch(() => null)) as { githubLinked?: boolean } | null;
  return body?.githubLinked === true;
}
