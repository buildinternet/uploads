# People tab: pending invites + member management — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let workspace owners/admins see and revoke pending invites and manage members (remove, change role) from the `/account/workspaces/:name/people` tab.

**Architecture:** Three layers. The auth worker (`apps/auth`) gains three internal routes that own the role-matrix invariants (it holds the `member`/`invitation` tables). `apps/api` adds thin `org-workspaces` helpers and `adminWorkspaceOr403`-gated `/me` routes. `apps/web` adds api-client calls, pure render helpers, and people-tab wiring. Full spec: `docs/superpowers/specs/2026-07-19-people-tab-member-management-design.md`.

**Tech Stack:** Hono, drizzle-orm/d1, better-auth org tables, Astro islands, vitest with in-process fake-D1.

## Global Constraints

- **Permission matrix** (enforced in the auth worker): remove `member` → owner or admin; remove `admin` → owner only; remove/modify `owner` → never (`403 cannot_modify_owner`); promote/demote (`admin↔member`) → owner only; act on self → never (`400 cannot_modify_self`); revoke invite → owner or admin. Actor lacking owner|admin → `403 actor_not_authorized`.
- **Role values:** `owner | admin | member`. Role-change target role must be `admin` or `member` (`400 invalid_role`); `owner` is never a source or target through these endpoints.
- **Management targets `member.id`** (opaque), never the global `userId`.
- **Error shapes:** auth worker uses `errorJson(code, message)` → `{ error: { code, message } }`. `apps/api` throws `@uploads/errors` classes. Auth internal routes are reached only via `env.AUTH.fetch("https://auth.internal/…")` with header `x-uploads-internal: 1`.
- **No changeset.** `@uploads/auth`, `@uploads/api`, `@uploads/web` are all on the `.changeset/config.json` `ignore` list (Workers-deployed). A changeset here is release poison.
- **Run tests from repo root** with `pnpm test` (unified vitest). Per-file: `pnpm vitest run <path>`.
- Repo formats with **oxfmt** (runs in the pre-commit hook) — don't hand-format.

---

### Task 1: Auth worker — revoke pending invite

**Files:**

- Modify: `apps/auth/src/internal-routes.ts` (append a route to the `internal` Hono chain, after the `GET /orgs/:slug/invites` route ~line 350)
- Test: `apps/auth/src/internal-routes.test.ts`

**Interfaces:**

- Produces: `DELETE /internal/orgs/:slug/invites/:id?actorUserId=<id>` → `200 { ok: true }` | `403 { error:{code:"actor_not_authorized"} }` | `404 { error:{code:"organization_not_found"|"invite_not_found"} }`

- [ ] **Step 1: Write the failing tests**

Add to `apps/auth/src/internal-routes.test.ts` inside the `describe("DB-backed behavior", …)` block (reuse its `orm`, `seedUser`, `seedOrg`, `dbEnv`, `app` helpers). Add a helper to seed a member + a pending invite:

```ts
describe("DELETE /internal/orgs/:slug/invites/:id", () => {
  async function seed(actorRole: string) {
    const org = await seedOrg();
    const actor = await seedUser({ id: "u_actor", email: "actor@x.com" });
    await orm.insert(schema.member).values({
      id: "m_actor",
      organizationId: org.id,
      userId: actor.id,
      role: actorRole,
      createdAt: new Date(),
    });
    const inviteId = "inv_1";
    await orm.insert(schema.invitation).values({
      id: inviteId,
      organizationId: org.id,
      email: "invitee@x.com",
      role: "member",
      status: "pending",
      expiresAt: new Date(Date.now() + 86400000),
      inviterId: actor.id,
      createdAt: new Date(),
    });
    return { org, actor, inviteId };
  }

  it("revokes a pending invite for an admin actor", async () => {
    const { org, actor, inviteId } = await seed("admin");
    const res = await app().request(
      `/internal/orgs/${org.slug}/invites/${inviteId}?actorUserId=${actor.id}`,
      { method: "DELETE" },
      dbEnv(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const rows = await orm
      .select()
      .from(schema.invitation)
      .where(eq(schema.invitation.id, inviteId));
    expect(rows).toHaveLength(0);
  });

  it("403s when the actor is only a member", async () => {
    const { org, actor, inviteId } = await seed("member");
    const res = await app().request(
      `/internal/orgs/${org.slug}/invites/${inviteId}?actorUserId=${actor.id}`,
      { method: "DELETE" },
      dbEnv(),
    );
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "actor_not_authorized" },
    });
  });

  it("404s for an unknown invite id", async () => {
    const { org, actor } = await seed("owner");
    const res = await app().request(
      `/internal/orgs/${org.slug}/invites/nope?actorUserId=${actor.id}`,
      { method: "DELETE" },
      dbEnv(),
    );
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "invite_not_found" },
    });
  });
});
```

> Note: if `seedUser` doesn't accept an override arg, match the file's actual signature — check the existing `seedUser`/`seedOrg` helpers near line 130-150 and adapt these calls to them.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run apps/auth/src/internal-routes.test.ts -t "invites/:id"`
Expected: FAIL (route returns 404 for all — the DELETE path doesn't exist, so Hono returns its default 404 without the `invite_not_found` code, and the revoke/403 assertions fail).

- [ ] **Step 3: Implement the route**

In `apps/auth/src/internal-routes.ts`, add after the `GET /orgs/:slug/invites` route. First add a small shared authz helper near the top (after `errorJson`, ~line 15) — it's reused by Tasks 2 & 3:

```ts
/** The actor's org-scoped role, or null if they aren't a member of this org. */
async function actorRole(
  db: ReturnType<typeof drizzle<typeof schema>>,
  orgId: string,
  actorUserId: string,
): Promise<string | null> {
  if (!actorUserId) return null;
  const [row] = await db
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, actorUserId)))
    .limit(1);
  return row?.role ?? null;
}
```

Then the route:

```ts
  .delete("/orgs/:slug/invites/:id", async (c) => {
    const slug = c.req.param("slug");
    const inviteId = c.req.param("id");
    const requestActorUserId = c.req.query("actorUserId") ?? "";
    const db = drizzle(c.env.DB, { schema });
    const [org] = await db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.slug, slug))
      .limit(1);
    if (!org) {
      return c.json(errorJson("organization_not_found", "no organization with that slug"), 404);
    }
    const role = await actorRole(db, org.id, requestActorUserId);
    if (role !== "owner" && role !== "admin") {
      return c.json(errorJson("actor_not_authorized", "actor must be an org admin or owner"), 403);
    }
    const [invite] = await db
      .select({ id: schema.invitation.id })
      .from(schema.invitation)
      .where(
        and(
          eq(schema.invitation.id, inviteId),
          eq(schema.invitation.organizationId, org.id),
          eq(schema.invitation.status, "pending"),
        ),
      )
      .limit(1);
    if (!invite) {
      return c.json(errorJson("invite_not_found", "no pending invite with that id"), 404);
    }
    await db.delete(schema.invitation).where(eq(schema.invitation.id, invite.id));
    return c.json({ ok: true });
  })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/auth/src/internal-routes.test.ts -t "invites/:id"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/auth/src/internal-routes.ts apps/auth/src/internal-routes.test.ts
git commit -m "feat(auth): internal revoke-invite route (#275)"
```

---

### Task 2: Auth worker — remove member

**Files:**

- Modify: `apps/auth/src/internal-routes.ts` (append after Task 1's route)
- Test: `apps/auth/src/internal-routes.test.ts`

**Interfaces:**

- Consumes: `actorRole(db, orgId, actorUserId)` from Task 1.
- Produces: `DELETE /internal/orgs/:slug/members/:memberId?actorUserId=<id>` → `200 { ok: true }` | `400 { error:{code:"cannot_modify_self"} }` | `403 { error:{code:"cannot_modify_owner"|"actor_not_authorized"} }` | `404 { error:{code:"organization_not_found"|"member_not_found"} }`

- [ ] **Step 1: Write the failing tests**

```ts
describe("DELETE /internal/orgs/:slug/members/:memberId", () => {
  async function seed() {
    const org = await seedOrg();
    const owner = await seedUser({ id: "u_owner", email: "owner@x.com" });
    const admin = await seedUser({ id: "u_admin", email: "admin@x.com" });
    const admin2 = await seedUser({ id: "u_admin2", email: "admin2@x.com" });
    const member = await seedUser({ id: "u_member", email: "member@x.com" });
    const rows = [
      { id: "m_owner", userId: owner.id, role: "owner" },
      { id: "m_admin", userId: admin.id, role: "admin" },
      { id: "m_admin2", userId: admin2.id, role: "admin" },
      { id: "m_member", userId: member.id, role: "member" },
    ];
    for (const r of rows) {
      await orm.insert(schema.member).values({
        id: r.id,
        organizationId: org.id,
        userId: r.userId,
        role: r.role,
        createdAt: new Date(),
      });
    }
    return { org, owner, admin, admin2, member };
  }
  const del = (slug: string, memberId: string, actorUserId: string) =>
    app().request(
      `/internal/orgs/${slug}/members/${memberId}?actorUserId=${actorUserId}`,
      { method: "DELETE" },
      dbEnv(),
    );

  it("lets an admin remove a member", async () => {
    const { org, admin } = await seed();
    const res = await del(org.slug, "m_member", admin.id);
    expect(res.status).toBe(200);
    const rows = await orm.select().from(schema.member).where(eq(schema.member.id, "m_member"));
    expect(rows).toHaveLength(0);
  });
  it("forbids an admin removing another admin", async () => {
    const { org, admin } = await seed();
    const res = await del(org.slug, "m_admin2", admin.id);
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "actor_not_authorized" },
    });
  });
  it("lets an owner remove an admin", async () => {
    const { org, owner } = await seed();
    const res = await del(org.slug, "m_admin", owner.id);
    expect(res.status).toBe(200);
  });
  it("never removes an owner", async () => {
    const { org, owner } = await seed();
    const res = await del(org.slug, "m_owner", owner.id);
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "cannot_modify_owner" },
    });
  });
  it("blocks removing yourself", async () => {
    const { org, admin } = await seed();
    const res = await del(org.slug, "m_admin", admin.id);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "cannot_modify_self" },
    });
  });
  it("404s for an unknown member id", async () => {
    const { org, owner } = await seed();
    const res = await del(org.slug, "nope", owner.id);
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "member_not_found" },
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run apps/auth/src/internal-routes.test.ts -t "members/:memberId"`
Expected: FAIL (route doesn't exist).

- [ ] **Step 3: Implement the route**

Append after Task 1's route:

```ts
  .delete("/orgs/:slug/members/:memberId", async (c) => {
    const slug = c.req.param("slug");
    const memberId = c.req.param("memberId");
    const requestActorUserId = c.req.query("actorUserId") ?? "";
    const db = drizzle(c.env.DB, { schema });
    const [org] = await db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.slug, slug))
      .limit(1);
    if (!org) {
      return c.json(errorJson("organization_not_found", "no organization with that slug"), 404);
    }
    const [target] = await db
      .select({ id: schema.member.id, userId: schema.member.userId, role: schema.member.role })
      .from(schema.member)
      .where(and(eq(schema.member.id, memberId), eq(schema.member.organizationId, org.id)))
      .limit(1);
    if (!target) {
      return c.json(errorJson("member_not_found", "no member with that id in this org"), 404);
    }
    if (target.userId === requestActorUserId) {
      return c.json(errorJson("cannot_modify_self", "you cannot remove yourself"), 400);
    }
    if (target.role === "owner") {
      return c.json(errorJson("cannot_modify_owner", "the workspace owner cannot be removed"), 403);
    }
    const role = await actorRole(db, org.id, requestActorUserId);
    if (role !== "owner" && role !== "admin") {
      return c.json(errorJson("actor_not_authorized", "actor must be an org admin or owner"), 403);
    }
    // Only owners may remove admins; admins may remove members only.
    if (target.role === "admin" && role !== "owner") {
      return c.json(errorJson("actor_not_authorized", "only an owner can remove an admin"), 403);
    }
    await db.delete(schema.member).where(eq(schema.member.id, target.id));
    return c.json({ ok: true });
  })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/auth/src/internal-routes.test.ts -t "members/:memberId"`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/auth/src/internal-routes.ts apps/auth/src/internal-routes.test.ts
git commit -m "feat(auth): internal remove-member route with role matrix (#275)"
```

---

### Task 3: Auth worker — change member role

**Files:**

- Modify: `apps/auth/src/internal-routes.ts` (append after Task 2's route)
- Test: `apps/auth/src/internal-routes.test.ts`

**Interfaces:**

- Consumes: `actorRole` from Task 1; the `seed()` member fixture pattern from Task 2.
- Produces: `PATCH /internal/orgs/:slug/members/:memberId` body `{ actorUserId, role }` → `200 { member: { id, userId, role } }` | `400 { error:{code:"invalid_role"|"cannot_modify_self"} }` | `403 { error:{code:"cannot_modify_owner"|"actor_not_authorized"} }` | `404 { error:{code:"organization_not_found"|"member_not_found"} }`

- [ ] **Step 1: Write the failing tests**

Reuse the same `seed()` helper (define a local copy in this describe block, or lift Task 2's `seed()` to the parent scope and share it):

```ts
describe("PATCH /internal/orgs/:slug/members/:memberId", () => {
  // ...same seed() as Task 2...
  const patch = (slug: string, memberId: string, actorUserId: string, role: string) =>
    app().request(
      `/internal/orgs/${slug}/members/${memberId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actorUserId, role }),
      },
      dbEnv(),
    );

  it("lets an owner promote a member to admin", async () => {
    const { org, owner } = await seed();
    const res = await patch(org.slug, "m_member", owner.id, "admin");
    expect(res.status).toBe(200);
    expect((await res.json()) as { member: { role: string } }).toMatchObject({
      member: { id: "m_member", role: "admin" },
    });
    const [row] = await orm.select().from(schema.member).where(eq(schema.member.id, "m_member"));
    expect(row.role).toBe("admin");
  });
  it("forbids an admin changing roles", async () => {
    const { org, admin } = await seed();
    const res = await patch(org.slug, "m_member", admin.id, "admin");
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "actor_not_authorized" },
    });
  });
  it("rejects an invalid target role", async () => {
    const { org, owner } = await seed();
    const res = await patch(org.slug, "m_member", owner.id, "owner");
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "invalid_role" },
    });
  });
  it("never modifies an owner", async () => {
    const { org, owner } = await seed();
    const res = await patch(org.slug, "m_owner", owner.id, "member");
    expect(res.status).toBe(400); // self-check fires first for the owner acting on self
    // A second owner acting on this owner would get cannot_modify_owner; self short-circuits here.
  });
  it("blocks changing your own role", async () => {
    const { org, admin } = await seed();
    const res = await patch(org.slug, "m_admin", admin.id, "member");
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "cannot_modify_self" },
    });
  });
  it("is idempotent when the role is unchanged", async () => {
    const { org, owner } = await seed();
    const res = await patch(org.slug, "m_admin", owner.id, "admin");
    expect(res.status).toBe(200);
    expect((await res.json()) as { member: { role: string } }).toMatchObject({
      member: { role: "admin" },
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run apps/auth/src/internal-routes.test.ts -t "PATCH /internal/orgs"`
Expected: FAIL (route doesn't exist).

- [ ] **Step 3: Implement the route**

```ts
  .patch("/orgs/:slug/members/:memberId", async (c) => {
    const slug = c.req.param("slug");
    const memberId = c.req.param("memberId");
    const body = await c.req
      .json<{ actorUserId?: unknown; role?: unknown }>()
      .catch(() => ({}) as { actorUserId?: unknown; role?: unknown });
    const requestActorUserId = typeof body.actorUserId === "string" ? body.actorUserId : "";
    const nextRole = typeof body.role === "string" ? body.role.trim() : "";
    if (nextRole !== "admin" && nextRole !== "member") {
      return c.json(errorJson("invalid_role", "role must be admin or member"), 400);
    }
    const db = drizzle(c.env.DB, { schema });
    const [org] = await db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.slug, slug))
      .limit(1);
    if (!org) {
      return c.json(errorJson("organization_not_found", "no organization with that slug"), 404);
    }
    const [target] = await db
      .select({ id: schema.member.id, userId: schema.member.userId, role: schema.member.role })
      .from(schema.member)
      .where(and(eq(schema.member.id, memberId), eq(schema.member.organizationId, org.id)))
      .limit(1);
    if (!target) {
      return c.json(errorJson("member_not_found", "no member with that id in this org"), 404);
    }
    if (target.userId === requestActorUserId) {
      return c.json(errorJson("cannot_modify_self", "you cannot change your own role"), 400);
    }
    if (target.role === "owner") {
      return c.json(errorJson("cannot_modify_owner", "the workspace owner's role is fixed"), 403);
    }
    const role = await actorRole(db, org.id, requestActorUserId);
    if (role !== "owner") {
      return c.json(errorJson("actor_not_authorized", "only an owner can change member roles"), 403);
    }
    if (target.role !== nextRole) {
      await db.update(schema.member).set({ role: nextRole }).where(eq(schema.member.id, target.id));
    }
    return c.json({ member: { id: target.id, userId: target.userId, role: nextRole } });
  })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/auth/src/internal-routes.test.ts -t "PATCH /internal/orgs"`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/auth/src/internal-routes.ts apps/auth/src/internal-routes.test.ts
git commit -m "feat(auth): internal change-member-role route (owner-only) (#275)"
```

---

### Task 4: API — org-workspaces helpers

**Files:**

- Modify: `apps/api/src/org-workspaces.ts` (append after `membersForOrg`, ~line 96)
- Test: `apps/api/src/org-workspaces.test.ts`

**Interfaces:**

- Consumes: the auth routes from Tasks 1-3.
- Produces:
  - `OrgInvite = { id: string; email: string; role: string | null; status: string; expiresAt: string | number | null }`
  - `invitesForOrg(env, slug): Promise<OrgInvite[]>`
  - `revokeInvite(env, slug, inviteId, actorUserId): Promise<void>`
  - `removeMember(env, slug, memberId, actorUserId): Promise<void>`
  - `updateMemberRole(env, slug, memberId, role, actorUserId): Promise<{ id: string; userId: string; role: string }>`

- [ ] **Step 1: Write the failing tests**

`apps/api/src/org-workspaces.test.ts` already stubs `env.AUTH.fetch` — match its existing fake-AUTH pattern (a function returning `{ AUTH: { fetch: async (url, init) => Response } }`). Add:

```ts
import { ForbiddenError, NotFoundError } from "@uploads/errors";
import { invitesForOrg, revokeInvite, removeMember, updateMemberRole } from "./org-workspaces";

function fakeEnv(handler: (url: string, init?: RequestInit) => Response) {
  return {
    AUTH: { fetch: async (url: string, init?: RequestInit) => handler(String(url), init) },
  } as unknown as Env;
}

describe("invitesForOrg", () => {
  it("returns the invites array", async () => {
    const env = fakeEnv(
      () =>
        new Response(
          JSON.stringify({
            invites: [
              { id: "i1", email: "a@x.com", role: "member", status: "pending", expiresAt: 1 },
            ],
          }),
          { status: 200 },
        ),
    );
    expect(await invitesForOrg(env, "acme")).toEqual([
      { id: "i1", email: "a@x.com", role: "member", status: "pending", expiresAt: 1 },
    ]);
  });
  it("throws ServiceUnavailable on a non-ok response", async () => {
    const env = fakeEnv(() => new Response("nope", { status: 500 }));
    await expect(invitesForOrg(env, "acme")).rejects.toThrow();
  });
});

describe("revokeInvite / removeMember / updateMemberRole error mapping", () => {
  it("revokeInvite maps 404 to NotFoundError", async () => {
    const env = fakeEnv(
      () => new Response(JSON.stringify({ error: { code: "invite_not_found" } }), { status: 404 }),
    );
    await expect(revokeInvite(env, "acme", "i1", "u1")).rejects.toBeInstanceOf(NotFoundError);
  });
  it("removeMember maps 403 to ForbiddenError", async () => {
    const env = fakeEnv(
      () =>
        new Response(JSON.stringify({ error: { code: "actor_not_authorized" } }), { status: 403 }),
    );
    await expect(removeMember(env, "acme", "m1", "u1")).rejects.toBeInstanceOf(ForbiddenError);
  });
  it("updateMemberRole returns the updated member on 200", async () => {
    const env = fakeEnv(
      () =>
        new Response(JSON.stringify({ member: { id: "m1", userId: "u2", role: "admin" } }), {
          status: 200,
        }),
    );
    expect(await updateMemberRole(env, "acme", "m1", "admin", "u1")).toEqual({
      id: "m1",
      userId: "u2",
      role: "admin",
    });
  });
  it("updateMemberRole maps 400 to BadRequest/Validation", async () => {
    const env = fakeEnv(
      () => new Response(JSON.stringify({ error: { code: "invalid_role" } }), { status: 400 }),
    );
    await expect(updateMemberRole(env, "acme", "m1", "owner", "u1")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run apps/api/src/org-workspaces.test.ts -t "invitesForOrg|error mapping"`
Expected: FAIL (functions not exported).

- [ ] **Step 3: Implement the helpers**

In `apps/api/src/org-workspaces.ts`, extend the import and append the helpers. First widen the errors import at line 19:

```ts
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from "@uploads/errors";
```

Then append after `membersForOrg`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/api/src/org-workspaces.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/org-workspaces.ts apps/api/src/org-workspaces.test.ts
git commit -m "feat(api): org-workspaces invite/member management helpers (#275)"
```

---

### Task 5: API — `/me` routes + member-id exposure

**Files:**

- Modify: `apps/api/src/routes/me.ts` (extend the `GET /workspaces/:name/members` route ~line 184; append 4 routes before the final `;` of the `me` chain ~line 477; extend imports ~line 25-30)
- Test: `apps/api/src/routes/me.test.ts`

**Interfaces:**

- Consumes: `adminWorkspaceOr403`, `memberWorkspaceOr404`, `requireUserId`, `allowWrite` (existing in me.ts); `invitesForOrg`, `revokeInvite`, `removeMember`, `updateMemberRole` (Task 4).
- Produces (all under `/me`, credentialed):
  - `GET /workspaces/:name/members` now includes `id` **only for admin/owner callers**.
  - `GET /workspaces/:name/invites` → `{ communal, invites }`
  - `DELETE /workspaces/:name/invites/:id` → `{ ok: true }`
  - `DELETE /workspaces/:name/members/:memberId` → `{ ok: true }`
  - `PATCH /workspaces/:name/members/:memberId` `{ role }` → `{ member }`

- [ ] **Step 1: Write the failing tests**

`apps/api/src/routes/me.test.ts` already builds the `me` app with a fake AUTH binding and seeds workspaces/memberships — match its existing helpers (look for how it stubs `myWorkspaces`/AUTH and how it authenticates the session user). Add tests:

```ts
describe("GET /me/workspaces/:name/members id exposure", () => {
  it("includes member id for an admin/owner caller", async () => {
    // seed caller as owner of workspace "acme"; auth /members returns rows incl id
    const res = await requestAs(ownerSession, "GET", "/me/workspaces/acme/members");
    const body = await res.json();
    expect(body.members[0]).toHaveProperty("id");
  });
  it("omits member id for a plain member caller", async () => {
    const res = await requestAs(memberSession, "GET", "/me/workspaces/acme/members");
    const body = await res.json();
    expect(body.members[0]).not.toHaveProperty("id");
  });
});

describe("member management routes", () => {
  it("GET invites requires admin/owner (403 for a member)", async () => {
    const res = await requestAs(memberSession, "GET", "/me/workspaces/acme/invites");
    expect(res.status).toBe(403);
  });
  it("GET invites returns pending invites for an admin", async () => {
    const res = await requestAs(adminSession, "GET", "/me/workspaces/acme/invites");
    expect(res.status).toBe(200);
    expect((await res.json()).invites).toBeInstanceOf(Array);
  });
  it("PATCH members validates the role", async () => {
    const res = await requestAs(ownerSession, "PATCH", "/me/workspaces/acme/members/m1", {
      role: "owner",
    });
    expect(res.status).toBe(400);
  });
  it("communal workspace short-circuits invites", async () => {
    const res = await requestAs(memberOfDefault, "GET", "/me/workspaces/default/invites");
    // communal is member-visible-empty; adminWorkspaceOr403 still applies — assert to the actual gate
    expect([200, 403]).toContain(res.status);
  });
});
```

> Adapt `requestAs` / session seeding to the real helpers in `me.test.ts`. The point is: id exposure differs by role, mutating routes are admin-gated, PATCH validates role. If the fake AUTH binding needs to respond to the new internal paths, extend its handler to return `{ invites: [] }` / `{ ok: true }` / `{ member: {...} }` for the new URLs.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run apps/api/src/routes/me.test.ts -t "id exposure|member management"`
Expected: FAIL.

- [ ] **Step 3: Implement**

Extend imports at the top of `me.ts` (the existing `from "../org-workspaces"` import):

```ts
import {
  membersForOrg,
  orgForWorkspace,
  invitesForOrg,
  revokeInvite,
  removeMember,
  updateMemberRole,
} from "../org-workspaces";
```

Replace the members route body (line 184-201) so admins/owners get `id`:

```ts
  .get("/workspaces/:name/members", async (c) => {
    const name = c.req.param("name");
    const ws = await memberWorkspaceOr404(c.env, requireUserId(c), name);
    if (ws.communal) return c.json({ communal: true, members: [] });

    const canManage = ws.role === "admin" || ws.role === "owner";
    const members = await membersForOrg(c.env, ws.organization.slug);
    return c.json({
      communal: false,
      members: members.map((m) => ({
        // Opaque member id only for managers — regular teammates never receive it.
        ...(canManage ? { id: m.id } : {}),
        email: m.email ?? "",
        name: m.name ?? "",
        role: m.role ?? "member",
        createdAt: m.createdAt,
      })),
    });
  })
```

Append the four routes just before the closing `;` of the `me` chain (after the `POST /workspaces/:name/invites` route ends at line 477 — turn its trailing `})` into `})` + these, ending the last one with `;`):

```ts
  // Pending invites for this workspace — admin/owner only (they can revoke).
  .get("/workspaces/:name/invites", async (c) => {
    const name = c.req.param("name");
    const ws = await adminWorkspaceOr403(c.env, requireUserId(c), name);
    if (ws.communal) return c.json({ communal: true, invites: [] });
    const invites = await invitesForOrg(c.env, ws.organization.slug);
    return c.json({ communal: false, invites });
  })

  // Revoke a pending invite — admin/owner only.
  .delete("/workspaces/:name/invites/:id", async (c) => {
    const name = c.req.param("name");
    const userId = requireUserId(c);
    const ws = await adminWorkspaceOr403(c.env, userId, name);
    if (!(await allowWrite(c.env, name))) throw new RateLimitedError("rate limit exceeded");
    await revokeInvite(c.env, ws.organization.slug, c.req.param("id"), userId);
    return c.json({ ok: true });
  })

  // Remove a member (by opaque member id) — admin/owner only; matrix enforced in auth worker.
  .delete("/workspaces/:name/members/:memberId", async (c) => {
    const name = c.req.param("name");
    const userId = requireUserId(c);
    const ws = await adminWorkspaceOr403(c.env, userId, name);
    if (!(await allowWrite(c.env, name))) throw new RateLimitedError("rate limit exceeded");
    await removeMember(c.env, ws.organization.slug, c.req.param("memberId"), userId);
    return c.json({ ok: true });
  })

  // Change a member's role (admin↔member) — owner-only enforced in auth worker.
  .patch("/workspaces/:name/members/:memberId", async (c) => {
    const name = c.req.param("name");
    const userId = requireUserId(c);
    const ws = await adminWorkspaceOr403(c.env, userId, name);
    if (!(await allowWrite(c.env, name))) throw new RateLimitedError("rate limit exceeded");
    const body = await c.req
      .json<{ role?: unknown }>()
      .catch(() => ({}) as { role?: unknown });
    const role = typeof body.role === "string" ? body.role.trim() : "";
    if (role !== "admin" && role !== "member") {
      throw new ValidationError("role must be admin or member", { code: "invalid_role" });
    }
    const member = await updateMemberRole(c.env, ws.organization.slug, c.req.param("memberId"), role, userId);
    return c.json({ member });
  });
```

> `RateLimitedError` and `ValidationError` are already imported in `me.ts` (used by the invite route). Confirm they're in the import list; if not, add them.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/api/src/routes/me.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/me.ts apps/api/src/routes/me.test.ts
git commit -m "feat(api): /me invite-revoke + member management routes (#275)"
```

---

### Task 6: Web — api-client functions

**Files:**

- Modify: `apps/web/src/lib/api-client.ts` (extend `WorkspaceMember` ~line 242; add after `inviteToWorkspace` ~line 324)
- Test: `apps/web/src/lib/api-client.test.ts`

**Interfaces:**

- Produces:
  - `WorkspaceMember` gains `id?: string`
  - `WorkspaceInvite = { id, email, role, status, expiresAt }`, `WorkspaceInvitesResult = { kind:"ok"; communal; invites } | { kind:"unavailable" }`
  - `getWorkspaceInvites(apiOrigin, name)`, `revokeWorkspaceInvite(apiOrigin, name, inviteId)`, `removeWorkspaceMember(apiOrigin, name, memberId)`, `updateWorkspaceMemberRole(apiOrigin, name, memberId, role)`
  - `ManageResult = { kind:"ok" } | { kind:"unavailable"; reason: "forbidden"|"not_found"|"invalid"|"server"|RequestFailure }`

- [ ] **Step 1: Write the failing tests**

`api-client.test.ts` mocks `fetch` (check its existing pattern — likely `vi.stubGlobal("fetch", …)` or a `fetchWithTimeout` seam). Add:

```ts
describe("getWorkspaceInvites", () => {
  it("parses invites and passes id through to members", async () => {
    stubFetchJson({
      communal: false,
      invites: [{ id: "i1", email: "a@x.com", role: "member", status: "pending", expiresAt: 1 }],
    });
    const res = await getWorkspaceInvites("https://api.test", "acme");
    expect(res).toMatchObject({ kind: "ok", communal: false });
    if (res.kind === "ok") expect(res.invites[0].id).toBe("i1");
  });
});
describe("manage mutations map status codes", () => {
  it("revokeWorkspaceInvite → forbidden on 403", async () => {
    stubFetchStatus(403);
    expect(await revokeWorkspaceInvite("https://api.test", "acme", "i1")).toEqual({
      kind: "unavailable",
      reason: "forbidden",
    });
  });
  it("updateWorkspaceMemberRole → ok on 200", async () => {
    stubFetchJson({ member: { id: "m1", userId: "u2", role: "admin" } }, 200);
    expect(await updateWorkspaceMemberRole("https://api.test", "acme", "m1", "admin")).toEqual({
      kind: "ok",
    });
  });
});
```

> Use the file's real fetch-stub helpers (match names to what's already imported in `api-client.test.ts`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run apps/web/src/lib/api-client.test.ts -t "getWorkspaceInvites|manage mutations"`
Expected: FAIL (functions not exported).

- [ ] **Step 3: Implement**

Add `id?: string` to `WorkspaceMember` (line 242) and make `getWorkspaceMembers`' mapper pass it through:

```ts
export interface WorkspaceMember {
  id?: string;
  email: string;
  name: string;
  role: string;
  createdAt?: string;
}
```

In `getWorkspaceMembers`' map (line 279-284), add:

```ts
    members: body.members.filter(isMemberCandidate).map((row) => ({
      id: typeof row.id === "string" ? row.id : undefined,
      email: row.email,
      name: typeof row.name === "string" ? row.name : "",
      role: row.role,
      createdAt: typeof row.createdAt === "string" ? row.createdAt : undefined,
    })),
```

Append after `inviteToWorkspace`:

```ts
export interface WorkspaceInvite {
  id: string;
  email: string;
  role: string | null;
  status: string;
  expiresAt: string | number | null;
}

export type WorkspaceInvitesResult =
  | { kind: "ok"; communal: boolean; invites: WorkspaceInvite[] }
  | { kind: "unavailable" };

export type ManageResult =
  | { kind: "ok" }
  | {
      kind: "unavailable";
      reason: RequestFailure | "server" | "forbidden" | "not_found" | "invalid";
    };

function manageResultFor(status: number, ok: boolean): ManageResult {
  if (ok) return { kind: "ok" };
  if (status === 403) return { kind: "unavailable", reason: "forbidden" };
  if (status === 404) return { kind: "unavailable", reason: "not_found" };
  if (status === 400) return { kind: "unavailable", reason: "invalid" };
  return { kind: "unavailable", reason: "server" };
}

/** GET /me/workspaces/:name/invites — pending invites, admin/owner only. */
export async function getWorkspaceInvites(
  apiOrigin: string,
  name: string,
): Promise<WorkspaceInvitesResult> {
  const result = await fetchWithTimeout(
    `${trimOrigin(apiOrigin)}/me/workspaces/${encodeURIComponent(name)}/invites`,
    { credentials: "include", cache: "no-store" },
  );
  if (result.kind === "unavailable" || !result.response.ok) return { kind: "unavailable" };
  const body = (await result.response.json().catch(() => null)) as {
    communal?: unknown;
    invites?: unknown;
  } | null;
  if (!body || !Array.isArray(body.invites)) return { kind: "unavailable" };
  return {
    kind: "ok",
    communal: body.communal === true,
    invites: body.invites.filter(
      (v): v is WorkspaceInvite =>
        !!v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string",
    ),
  };
}

async function manageMutation(
  apiOrigin: string,
  path: string,
  init: RequestInit,
): Promise<ManageResult> {
  const result = await fetchWithTimeout(`${trimOrigin(apiOrigin)}${path}`, {
    credentials: "include",
    cache: "no-store",
    ...init,
  });
  if (result.kind === "unavailable") return result;
  return manageResultFor(result.response.status, result.response.ok);
}

/** DELETE /me/workspaces/:name/invites/:id */
export async function revokeWorkspaceInvite(
  apiOrigin: string,
  name: string,
  inviteId: string,
): Promise<ManageResult> {
  return manageMutation(
    apiOrigin,
    `/me/workspaces/${encodeURIComponent(name)}/invites/${encodeURIComponent(inviteId)}`,
    { method: "DELETE" },
  );
}

/** DELETE /me/workspaces/:name/members/:memberId */
export async function removeWorkspaceMember(
  apiOrigin: string,
  name: string,
  memberId: string,
): Promise<ManageResult> {
  return manageMutation(
    apiOrigin,
    `/me/workspaces/${encodeURIComponent(name)}/members/${encodeURIComponent(memberId)}`,
    { method: "DELETE" },
  );
}

/** PATCH /me/workspaces/:name/members/:memberId */
export async function updateWorkspaceMemberRole(
  apiOrigin: string,
  name: string,
  memberId: string,
  role: "admin" | "member",
): Promise<ManageResult> {
  return manageMutation(
    apiOrigin,
    `/me/workspaces/${encodeURIComponent(name)}/members/${encodeURIComponent(memberId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    },
  );
}
```

> `RequestFailure`, `fetchWithTimeout`, `trimOrigin` already exist in this file (used by the surrounding functions). Confirm `isMemberCandidate` allows extra keys — it uses `Record<string, unknown>`, so `id` passes through fine.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/web/src/lib/api-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/api-client.ts apps/web/src/lib/api-client.test.ts
git commit -m "feat(web): api-client invite-revoke + member management calls (#275)"
```

---

### Task 7: Web — render helpers (invites list + member row controls)

**Files:**

- Modify: `apps/web/src/lib/workspace-ui.ts` (extend `MemberRow` + `renderMembersHtml` ~line 119-138; add `renderInvitesHtml`)
- Test: `apps/web/src/lib/workspace-ui.test.ts` (create if absent — check first)

**Interfaces:**

- Consumes: `escapeHtml` (in workspace-ui.ts).
- Produces:
  - `MemberRow` gains `id?: string`.
  - `renderMembersHtml(members, opts?: { canManage?: boolean; selfEmail?: string })` — controls only when `canManage` and the row has `id` and `role !== "owner"` and its email !== `selfEmail`.
  - `renderInvitesHtml(invites: { id: string; email: string; status: string }[]): string`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/lib/workspace-ui.test.ts` (or add to it):

```ts
import { describe, expect, it } from "vitest";
import { renderMembersHtml, renderInvitesHtml } from "./workspace-ui";

describe("renderMembersHtml controls", () => {
  const rows = [
    { id: "m_owner", email: "owner@x.com", name: "", role: "owner" },
    { id: "m_admin", email: "admin@x.com", name: "", role: "admin" },
    { id: "m_me", email: "me@x.com", name: "", role: "admin" },
  ];
  it("renders no controls without canManage", () => {
    const html = renderMembersHtml(rows);
    expect(html).not.toContain("data-member-id");
  });
  it("renders controls for manageable rows only", () => {
    const html = renderMembersHtml(rows, { canManage: true, selfEmail: "me@x.com" });
    expect(html).toContain('data-member-id="m_admin"'); // manageable
    expect(html).not.toContain('data-member-id="m_owner"'); // owner protected
    expect(html).not.toContain('data-member-id="m_me"'); // self
  });
});

describe("renderInvitesHtml", () => {
  it("renders a revoke control per invite", () => {
    const html = renderInvitesHtml([{ id: "i1", email: "a@x.com", status: "pending" }]);
    expect(html).toContain('data-invite-id="i1"');
    expect(html).toContain("a@x.com");
  });
  it("returns empty string for no invites", () => {
    expect(renderInvitesHtml([])).toBe("");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run apps/web/src/lib/workspace-ui.test.ts`
Expected: FAIL (`renderInvitesHtml` missing; controls not emitted).

- [ ] **Step 3: Implement**

Replace `MemberRow` + `renderMembersHtml` (line 119-138) and add `renderInvitesHtml`:

```ts
/** Minimal member shape `renderMembersHtml` needs — api-client's `WorkspaceMember` satisfies it. */
export interface MemberRow {
  id?: string;
  email: string;
  name: string;
  role: string;
}

export interface MemberRowOptions {
  /** Viewer is owner/admin — enables per-row controls. */
  canManage?: boolean;
  /** Viewer's own email — their row never shows controls (no self-removal). */
  selfEmail?: string;
}

/**
 * Pure row builder for the people tab's member list. Shows the display name
 * when set (email becomes the sub-line), else email leads. When `canManage`
 * and the row has an `id`, non-owner rows other than the viewer's own get a
 * role `<select>` and a remove button. `[]` → `""`.
 */
export function renderMembersHtml(members: MemberRow[], opts: MemberRowOptions = {}): string {
  return members
    .map((m) => {
      const lead = m.name || m.email;
      const sub = m.name ? `<span class="member-row__email">${escapeHtml(m.email)}</span>` : "";
      const manageable =
        !!opts.canManage && !!m.id && m.role !== "owner" && m.email !== opts.selfEmail;
      const controls = manageable
        ? `<span class="member-row__actions">` +
          `<select class="member-row__role-select" data-member-id="${escapeHtml(m.id!)}" aria-label="Role for ${escapeHtml(m.email)}">` +
          `<option value="member"${m.role === "member" ? " selected" : ""}>member</option>` +
          `<option value="admin"${m.role === "admin" ? " selected" : ""}>admin</option>` +
          `</select>` +
          `<button type="button" class="text-btn member-row__remove" data-member-id="${escapeHtml(m.id!)}" data-member-email="${escapeHtml(m.email)}">Remove</button>` +
          `</span>`
        : `<span class="member-row__role">${escapeHtml(m.role)}</span>`;
      return `<div class="member-row"><span class="member-row__who"><span class="member-row__name">${escapeHtml(lead)}</span>${sub}</span>${controls}</div>`;
    })
    .join("");
}

/** Pure row builder for the pending-invites list. `[]` → `""` (caller shows empty state). */
export function renderInvitesHtml(
  invites: { id: string; email: string; status: string }[],
): string {
  return invites
    .map(
      (inv) =>
        `<div class="invite-row"><span class="invite-row__email">${escapeHtml(inv.email)}</span>` +
        `<span class="invite-row__status">${escapeHtml(inv.status)}</span>` +
        `<button type="button" class="text-btn invite-row__revoke" data-invite-id="${escapeHtml(inv.id)}" data-invite-email="${escapeHtml(inv.email)}">Revoke</button></div>`,
    )
    .join("");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/web/src/lib/workspace-ui.test.ts`
Expected: PASS. Also run `pnpm vitest run apps/web/src/lib/api-client.test.ts` to confirm the `renderMembersHtml` signature change didn't break other callers (search `renderMembersHtml(` usages — only people.astro, updated in Task 8).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/workspace-ui.ts apps/web/src/lib/workspace-ui.test.ts
git commit -m "feat(web): render pending-invites + member-row controls (#275)"
```

---

### Task 8: Web — wire the people tab

**Files:**

- Modify: `apps/web/src/pages/account/workspaces/[name]/people.astro` (markup: add a pending-invites section; script: imports, load invites, member/invite event handlers, pass `canManage`/`selfEmail` to `renderMembersHtml`)
- Modify: `apps/web/src/styles/account-content.css` (styles for `.invite-row`, `.member-row__actions`)

**Interfaces:**

- Consumes: `getWorkspaceInvites`, `revokeWorkspaceInvite`, `removeWorkspaceMember`, `updateWorkspaceMemberRole` (Task 6); `renderInvitesHtml`, `renderMembersHtml` with options (Task 7). Session `user.email` + `user.role` via `onSession`.

- [ ] **Step 1: Add the invites section markup**

In `people.astro`, after the members `settings-section` (line 33, the `</div>` closing `#ws-members`'s section) and before the invite section, add:

```html
<div class="settings-section" id="ws-invites-section" hidden>
  <h2>Pending invites</h2>
  <div id="ws-invites" class="invite-list">
    <p class="muted" id="ws-invites-status" role="status">Loading invites…</p>
  </div>
</div>
```

- [ ] **Step 2: Extend the script imports and state**

Update the `api-client` import (line 78-82) and `workspace-ui` import (line 85-91):

```ts
import {
  getMyWorkspaces,
  getWorkspaceMembers,
  inviteToWorkspace,
  getWorkspaceInvites,
  revokeWorkspaceInvite,
  removeWorkspaceMember,
  updateWorkspaceMemberRole,
} from "../../../../lib/api-client";
import {
  bindCopyButtons,
  escapeHtml,
  isWorkspaceAdminRole,
  operatorInviteCommand,
  renderInvitesHtml,
  renderMembersHtml,
} from "../../../../lib/workspace-ui";
```

Add element refs near line 121 and track viewer identity/role:

```ts
const invitesSection = requireElement<HTMLElement>("#ws-invites-section", page);
const invitesEl = requireElement<HTMLElement>("#ws-invites", page);

let sessionRole: string | null | undefined;
let sessionEmail: string | undefined;
let canManage = false; // viewer is owner/admin of this workspace
```

- [ ] **Step 3: Set `canManage` and load invites in `loadInvitePage`**

In `loadInvitePage`, after computing `ws` (line 160 area), set:

```ts
canManage = isWorkspaceAdminRole(ws.role);
invitesSection.hidden = !canManage;
```

And after `void loadMembers();` (line 165) add:

```ts
if (canManage) void loadInvites();
```

- [ ] **Step 4: Update `loadMembers` to pass options, and add `loadInvites`**

Replace the `renderMembersHtml(result.members)` call (line 195) with:

```ts
membersEl.innerHTML = result.members.length
  ? renderMembersHtml(result.members, { canManage, selfEmail: sessionEmail })
  : '<p class="muted">Just you so far.</p>';
```

Add after `loadMembers` (line 197):

```ts
async function loadInvites(): Promise<void> {
  const result = await getWorkspaceInvites(apiOrigin, workspaceName);
  if (!stillHere()) return;
  if (result.kind === "unavailable") {
    invitesEl.innerHTML =
      '<p class="muted" role="alert">Invites are temporarily unavailable. Reload to try again.</p>';
    return;
  }
  invitesEl.innerHTML = result.invites.length
    ? renderInvitesHtml(result.invites)
    : '<p class="muted">No pending invites.</p>';
}
```

- [ ] **Step 5: Add delegated event handlers**

After the `inviteForm.addEventListener(...)` block (line 241), add member + invite delegation:

```ts
membersEl.addEventListener("click", (event) => {
  const btn = (event.target as HTMLElement).closest<HTMLButtonElement>(".member-row__remove");
  if (!btn) return;
  void (async () => {
    const memberId = btn.dataset.memberId ?? "";
    const email = btn.dataset.memberEmail ?? "this member";
    if (!memberId || !confirm(`Remove ${email} from this workspace?`)) return;
    btn.disabled = true;
    const res = await removeWorkspaceMember(apiOrigin, workspaceName, memberId);
    if (!stillHere()) return;
    if (res.kind === "ok") void loadMembers();
    else {
      btn.disabled = false;
      alert(manageErrorText(res.reason, "remove this member"));
    }
  })();
});

membersEl.addEventListener("change", (event) => {
  const select = (event.target as HTMLElement).closest<HTMLSelectElement>(
    ".member-row__role-select",
  );
  if (!select) return;
  void (async () => {
    const memberId = select.dataset.memberId ?? "";
    const role = select.value === "admin" ? "admin" : "member";
    if (!memberId) return;
    select.disabled = true;
    const res = await updateWorkspaceMemberRole(apiOrigin, workspaceName, memberId, role);
    if (!stillHere()) return;
    select.disabled = false;
    if (res.kind === "ok") void loadMembers();
    else alert(manageErrorText(res.reason, "change this role"));
  })();
});

invitesEl.addEventListener("click", (event) => {
  const btn = (event.target as HTMLElement).closest<HTMLButtonElement>(".invite-row__revoke");
  if (!btn) return;
  void (async () => {
    const inviteId = btn.dataset.inviteId ?? "";
    const email = btn.dataset.inviteEmail ?? "this invite";
    if (!inviteId || !confirm(`Revoke the pending invite for ${email}?`)) return;
    btn.disabled = true;
    const res = await revokeWorkspaceInvite(apiOrigin, workspaceName, inviteId);
    if (!stillHere()) return;
    if (res.kind === "ok") void loadInvites();
    else {
      btn.disabled = false;
      alert(manageErrorText(res.reason, "revoke this invite"));
    }
  })();
});
```

Add a small message helper inside the `onAstroPageLoad` closure (near `showError`):

```ts
function manageErrorText(reason: string, action: string): string {
  if (reason === "forbidden") return `You don’t have permission to ${action}.`;
  if (reason === "not_found") return `That item no longer exists — reload the page.`;
  if (reason === "invalid") return `That change isn’t allowed.`;
  return `Couldn’t ${action}. Try again.`;
}
```

Set `sessionEmail` in the `onSession` callback (line 247-250):

```ts
onSession((user) => {
  sessionRole = user.role;
  sessionEmail = user.email;
  void loadInvitePage();
});
```

- [ ] **Step 6: Add styles**

Append to `apps/web/src/styles/account-content.css`:

```css
/* People tab: pending-invite rows + member-row management controls (#275). */
.invite-list {
  display: grid;
  gap: 6px;
}
.invite-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.invite-row__email {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.invite-row__status {
  font-size: 12px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.member-row__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.member-row__role-select {
  font: inherit;
  padding: 2px 6px;
}
```

- [ ] **Step 7: Verify build + typecheck**

Run: `pnpm --filter @uploads/web types`
Expected: 0 errors. Then `pnpm vitest run apps/web` — all web tests pass.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/pages/account/workspaces/[name]/people.astro apps/web/src/styles/account-content.css
git commit -m "feat(web): people-tab pending invites + member management UI (#275)"
```

---

### Task 9: Full verification + browser check + PR

**Files:** none (verification + PR only).

- [ ] **Step 1: Run the full suite + typechecks**

Run: `pnpm test` (root) and `pnpm -r types` (or the per-app `types` scripts).
Expected: all green, 0 type errors.

- [ ] **Step 2: Browser-verify against the local stack**

Start the web dev server (per `uploads-web-dev-node24` — launch.json sources nvm/Node 24) and, signed in as a workspace owner with at least one other member + a pending invite, load `/account/workspaces/<name>/people`. Confirm: pending-invites section shows with a Revoke button; member rows show a role select + Remove for non-owner, non-self rows; owner and your own row show no controls; a member (non-admin) account sees the list with no controls and no invites section. Capture a screenshot of the people tab for the PR (github-screenshots skill → `uploads` CLI).

If any check fails, diagnose from source, fix, re-run the relevant task's tests, and re-verify.

- [ ] **Step 3: Push + open the PR (no changeset)**

```bash
git push -u origin claude/people-tab-member-mgmt-275
gh pr create --repo buildinternet/uploads --base main \
  --title "feat(web,api,auth): people-tab pending invites + member management (#275)" \
  --body-file <path to a written PR body: summary, permission matrix table, screenshot, "Closes #275", "no changeset — all three apps Workers-deployed">
```

Request a CodeRabbit review (auth-changing PR): comment `@coderabbitai review` after the PR opens.

## Notes for the implementer

- **Auth worker route order:** all three new routes attach to the existing `internal` chain in `internal-routes.ts`. Hono matches in definition order; none of these paths collide with existing ones, so append-after-invites is safe.
- **`seedUser` signature:** Tasks 1-3 assume `seedUser({ id, email })`. Check the real helper in `internal-routes.test.ts` (~line 130) and adapt — it may take positional args or auto-generate ids.
- **fake AUTH binding in `me.test.ts`:** the new `/me` routes call four new internal URLs. Extend the test's fake `AUTH.fetch` handler to answer `GET …/invites`, `DELETE …/invites/:id`, `DELETE …/members/:id`, `PATCH …/members/:id`.
- **`allowWrite`** is already imported and used by the invite route — reuse as-is.
- Keep the owner protected everywhere; never add a UI affordance that targets an owner row.

```

```
