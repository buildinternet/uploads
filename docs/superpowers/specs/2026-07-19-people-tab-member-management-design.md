# People tab: pending invites + member management (issue #275)

Follow-up to #274, which added a read-only member list to the workspace **people** tab.
This adds, all admin/owner-gated on the user-facing `/account/workspaces/:name/people`
surface only (the `/admin` operator panel stays list-only for now):

- **Pending invites** with **revoke**.
- **Member management**: remove a member and change a member's role.

## Permission model

Org roles are `owner | admin | member` (the better-auth `member.role`, distinct from the
global `user.role`). The **last-admin guard from #260 does not apply** — it protects the
global `admin()` plugin, not the `member` table. Member-management invariants are therefore
enforced fresh, inside the auth worker (which owns the `member` table).

| Action                          | Owner actor                  | Admin actor                   |
| ------------------------------- | ---------------------------- | ----------------------------- |
| Remove a `member`               | ✅                           | ✅                            |
| Remove an `admin`               | ✅                           | ❌ `403 actor_not_authorized` |
| Remove an `owner`               | ❌ `403 cannot_modify_owner` | ❌ `403 cannot_modify_owner`  |
| Promote `member`→`admin`        | ✅                           | ✅                            |
| Demote `admin`→`member`         | ✅                           | ❌ `403 actor_not_authorized` |
| Set an `owner` to any role      | ❌ `403 cannot_modify_owner` | ❌ `403 cannot_modify_owner`  |
| Act on **self** (remove / role) | ❌ `400 cannot_modify_self`  | ❌ `400 cannot_modify_self`   |
| Revoke a pending invite         | ✅                           | ✅                            |

Consequences, by design:

- **Owner is immutable and unremovable via this UI.** There is exactly one owner per org
  (created at provision; no path mints a second), so "the last owner can never be removed or
  demoted" holds without any admin-counting query — the owner is simply protected from every
  actor including themselves.
- **Admins manage the member roster; only owners manage other admins.** Admins may promote
  members to admin (and remove members) — matching invites and common SaaS org models — but
  cannot remove, demote, or otherwise act on peer admins, nor touch the owner.
- **Self-actions are blocked** to avoid accidental self-lockout. "Leave workspace" is a
  separate future feature, not part of this work.

Role changes are limited to the `admin ↔ member` toggle; `owner` is never a source or target
role through these endpoints.

## Architecture

Three layers, extending existing patterns at each. Every new endpoint enforces authorization;
the auth worker is the single source of truth for the role matrix because it holds the tables.

### Layer 1 — auth worker (`apps/auth/src/internal-routes.ts`)

Three new internal routes on the existing `internal` Hono router (reached only via the `AUTH`
service binding behind `isInternalRequest`). Direct drizzle, matching the file's existing
insert/select style. Each resolves the org by slug (`404 organization_not_found`), looks up the
**actor** membership by `actorUserId` and the **target** membership by `member.id`, then applies
the matrix. Error shape is the file's `errorJson(code, message)` → `{ error: { code, message } }`.

- `DELETE /internal/orgs/:slug/invites/:id`
  - Query/body: `actorUserId`.
  - Actor must be org `owner|admin` → else `403 actor_not_authorized`.
  - Delete `invitation` where `id = :id AND organizationId = org.id AND status = "pending"`.
    Zero rows → `404 invite_not_found`. → `200 { ok: true }`.
- `DELETE /internal/orgs/:slug/members/:memberId`
  - Query/body: `actorUserId`.
  - Target member row (by `member.id`, scoped to org) → else `404 member_not_found`.
  - `target.userId === actorUserId` → `400 cannot_modify_self`.
  - `target.role === "owner"` → `403 cannot_modify_owner`.
  - `target.role === "admin"` and actor is not `owner` → `403 actor_not_authorized`.
  - Actor not `owner|admin` → `403 actor_not_authorized`.
  - Delete the `member` row. → `200 { ok: true }`.
- `PATCH /internal/orgs/:slug/members/:memberId`
  - Body: `{ actorUserId, role }`, `role ∈ {admin, member}` → else `400 invalid_role`.
  - Target member row → else `404 member_not_found`.
  - `target.userId === actorUserId` → `400 cannot_modify_self`.
  - `target.role === "owner"` → `403 cannot_modify_owner`.
  - Actor not `owner|admin` → `403 actor_not_authorized`.
  - `target.role === "admin"` and actor is not `owner` → `403 actor_not_authorized`
    (same peer-admin rule as remove).
  - Idempotent: already at `role` → `200` no-op.
  - Update `member.role`. → `200 { member: { id, userId, role } }`.

### Layer 2 — API (`apps/api`)

New helpers in `src/org-workspaces.ts`, following the established `internalHeaders()` /
`env.AUTH.fetch(INTERNAL_ORIGIN + …)` pattern and `@uploads/errors` mapping
(`ServiceUnavailableError` for non-ok/malformed, `ConflictError` for 409, per-function 404):

- `invitesForOrg(env, slug): Promise<OrgInvite[]>` — `GET …/invites`, returns `body.invites ?? []`.
  `OrgInvite = { id, email, role: string | null, status, expiresAt }`.
- `revokeInvite(env, slug, inviteId, actorUserId): Promise<void>` — `DELETE …/invites/:id`;
  map `404 → NotFoundError`, `403 → ForbiddenError`.
- `removeMember(env, slug, memberId, actorUserId): Promise<void>` — `DELETE …/members/:memberId`;
  map `404 → NotFoundError`, `403 → ForbiddenError`, `400 → BadRequestError`.
- `updateMemberRole(env, slug, memberId, role, actorUserId): Promise<{ id, userId, role }>` —
  `PATCH …/members/:memberId`; same error mapping.

New routes in `src/routes/me.ts`, appended to the `me` chain. All gated by the existing
exported `adminWorkspaceOr403(env, userId, name)`; the three mutating routes also pass through
the existing `allowWrite` limiter guard (as `POST …/invites` already does). `actorUserId` is the
session user id (`requireUserId(c)`).

- `GET /workspaces/:name/invites` — `adminWorkspaceOr403`; `communal` → `{ communal: true, invites: [] }`;
  else `{ communal: false, invites: invitesForOrg(slug) }` (id retained — needed to revoke; email
  visible is fine on an admin-gated route).
- `DELETE /workspaces/:name/invites/:id` — `adminWorkspaceOr403` + `allowWrite` → `revokeInvite`.
- `DELETE /workspaces/:name/members/:memberId` — `adminWorkspaceOr403` + `allowWrite` → `removeMember`.
- `PATCH /workspaces/:name/members/:memberId` — `adminWorkspaceOr403` + `allowWrite`,
  body `{ role }` validated `∈ {admin, member}` → `updateMemberRole`.

**Member handle exposure.** Management targets the opaque `member.id`, never the global
`userId`. The existing `GET /workspaces/:name/members` route (member-gated, seen by all members)
is extended to include `id` **only when the caller is `adminWorkspaceOr403`-eligible** (owner or
admin). It also already returns `role`; regular members keep today's sanitized
`{ email, name, role, createdAt }` with no `id` and thus no actionable handle. To decide whether
to include `id`, the route checks the caller's role from the same membership lookup rather than a
second fetch.

### Layer 3 — web (`apps/web`)

`src/lib/api-client.ts` gains, following the `getWorkspaceMembers` / `inviteToWorkspace` shape
(`credentials: "include"`, typed result unions):

- `getWorkspaceInvites(apiOrigin, name): Promise<WorkspaceInvitesResult>` where
  `WorkspaceInvitesResult = { kind:"ok", communal, invites: WorkspaceInvite[] } | { kind:"unavailable" }`,
  `WorkspaceInvite = { id, email, role, status, expiresAt }`.
- `revokeWorkspaceInvite(apiOrigin, name, inviteId)`, `removeWorkspaceMember(apiOrigin, name, memberId)`,
  `updateWorkspaceMemberRole(apiOrigin, name, memberId, role)` — each returning a small
  `{ ok } | { error }` union mapping `403 → forbidden`, `404 → not_found`, `400 → invalid`.
- `WorkspaceMember` gains optional `id?: string`.

`src/pages/account/workspaces/[name]/people.astro` + `src/lib/workspace-ui.ts`:

- A **Pending invites** section (new `#ws-invites` container), rendered for admin/owner only,
  populated by `getWorkspaceInvites`. `renderInvitesHtml(invites)` renders each row with the
  email, status, and a **revoke** button (`data-invite-id`); empty state "No pending invites."
- `renderMembersHtml` rows gain per-row controls — a role `<select>` (`admin`/`member`) and a
  **remove** button — rendered only when the viewer is admin/owner **and** the row has an `id`,
  and **suppressed on owner rows** (`role === "owner"`) and on the **viewer's own row** (matched
  by email against the session). Rows still render without controls otherwise (unchanged for
  regular members).
- Delegated event handlers wire revoke / remove / role-change, each with a `confirm()` on the
  destructive/irreversible ones, error surfacing, and a reload of the affected list on success.
  The server remains the real gate; client hiding is cosmetic.

## Testing

- **auth** (`apps/auth`): unit tests for the three routes — full authz matrix (owner vs admin vs
  member actor × member/admin/owner target), owner protection, self protection, `invalid_role`,
  idempotent role no-op, and the `404`s. Mirror `internal-routes` / `admin-last-guard.test.ts`
  fixtures.
- **api** (`apps/api`): `me.ts` route tests (gating, communal short-circuit, `id` exposed only to
  admin/owner) and `org-workspaces` helper tests (error mapping) against the in-process fakes.
- **web** (`apps/web`): `workspace-ui` unit tests for `renderInvitesHtml` and the members-row
  controls (owner row and self row omit controls; non-admin viewer omits controls).

## Out of scope

- The `/admin` operator panel (stays list-only; a possible separate follow-up).
- "Leave workspace" / self-removal.
- Minting additional owners / ownership transfer.
- Editing an existing invite's role (revoke + re-invite instead).

## Release

No changeset. `@uploads/auth`, `@uploads/api`, and `@uploads/web` are all on the changeset
`ignore` list (Workers-deployed via Workers Builds CI); a changeset targeting them is release
poison. Merge to `main` auto-deploys.
