/**
 * Canonical invites/members vertical (issue #613 phase 3):
 * `/v1/workspaces/:workspace/members`, `/people`, `/invites*`,
 * `/members/:memberId*`. Exercised through the real composed `app`
 * (index.ts) — same style as `routes-workspace-usage.test.ts` (phase 2).
 *
 * `POST /:workspace/invites` lives at `routes/workspaces.ts` (upgraded in
 * place to `dualGovernanceAuth`, not re-registered here) — its bearer-path
 * parity is proven in `src/routes/workspace-governance-invite.test.ts`
 * (unchanged, still green). This file adds the session-path coverage for
 * that route plus the fully-new session-only routes in
 * `routes/workspace-members.ts`.
 */
import { describe, expect, it } from "vitest";
import { createToken } from "../src/auth-db";
import { app } from "../src/index";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const MIGRATIONS = [
  "migrations/20260710120000_auth.sql",
  "migrations/20260711120000_invite_pages.sql",
  "migrations/20260712230000_token_minting_user.sql",
  "migrations/20260817180000_token_last_used.sql",
  "migrations/20260827160000_auth_enrollments_kind.sql",
  "migrations/20260827170000_auth_enrollments_multi_use.sql",
];

const ADMIN = { id: "u-admin", email: "admin@example.com", name: "Admin" };
const MEMBER = { id: "u-member", email: "member@example.com", name: "Member" };

function stubAuth(handler: (req: Request) => Response | Promise<Response>): Pick<Fetcher, "fetch"> {
  return {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      return handler(req);
    }) as Fetcher["fetch"],
  };
}

interface OrgMemberRow {
  id: string;
  userId: string;
  email: string;
  name: string | null;
  role: string;
}

interface EnvOpts {
  /** `undefined` = no session cookie sent at all (see requests below). `null` = signed-out (401). */
  sessionUser?: typeof ADMIN | typeof MEMBER | null;
  /** Empty array = not a member (404 posture everywhere in this vertical). */
  memberships?: { organizationId: string; organizationSlug: string; role: string }[];
  members?: OrgMemberRow[];
  invites?: { id: string; email: string; role: string; status: string; expiresAt: string | null }[];
  getSessionCalls?: { count: number };
  db?: SqliteD1;
  onDelete?: (path: string) => Response;
  onPatch?: (path: string, body: unknown) => Response;
  /** `undefined` = the cap check always 200s ok. */
  memberCapDenied?: boolean;
  onJoin?: (body: { organizationSlug?: string; userId?: string }) => Response;
  /** `undefined` = a live workspace record; `null` = no record at all (KV
   * miss); otherwise a raw record shape (e.g. `{ deletedAt: "..." }` or
   * `{ status: "purged", ... }`) for review finding 5's soft-delete guard. */
  workspaceRecord?: Record<string, unknown> | null;
}

function makeEnv(opts: EnvOpts = {}) {
  const {
    sessionUser = ADMIN,
    memberships = [{ organizationId: "org-1", organizationSlug: "acme", role: "admin" }],
    members = [
      { id: "m-admin", userId: ADMIN.id, email: ADMIN.email, name: ADMIN.name, role: "admin" },
    ],
    invites = [],
    getSessionCalls,
    db = new SqliteD1(MIGRATIONS),
    onDelete,
    onPatch,
    memberCapDenied = false,
    onJoin,
    workspaceRecord = { provider: "r2", bucket: "test" },
  } = opts;

  const auth = stubAuth(async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/api/auth/get-session") {
      if (getSessionCalls) getSessionCalls.count++;
      return sessionUser
        ? Response.json({ session: {}, user: sessionUser })
        : new Response(null, { status: 401 });
    }
    if (url.pathname === "/internal/memberships") {
      return Response.json(
        memberships.map((m) => ({
          organizationId: m.organizationId,
          organizationSlug: m.organizationSlug,
          organizationName: "Acme",
          role: m.role,
        })),
      );
    }
    if (url.pathname === "/internal/orgs/acme/members" && req.method === "GET") {
      return Response.json({ members });
    }
    if (url.pathname === "/internal/orgs/acme/invites" && req.method === "GET") {
      return Response.json({ invites });
    }
    if (url.pathname === "/internal/orgs/acme" && req.method === "GET") {
      return Response.json({ organization: { id: "org-1", slug: "acme", name: "Acme" } });
    }
    if (url.pathname === "/internal/invite" && req.method === "POST") {
      const body = (await req.json()) as { email?: string };
      return Response.json(
        { invitation: { id: "inv-1", email: body.email, role: "member", status: "pending" } },
        { status: 201 },
      );
    }
    if (url.pathname === "/internal/member-cap/check" && req.method === "POST") {
      if (memberCapDenied) {
        return Response.json(
          {
            error: {
              code: "member_cap_reached",
              message: "This workspace has reached its member limit.",
            },
          },
          { status: 403 },
        );
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === "/internal/join" && req.method === "POST") {
      const body = (await req.json()) as { organizationSlug?: string; userId?: string };
      if (onJoin) return onJoin(body);
      return Response.json({ alreadyMember: false }, { status: 201 });
    }
    if (req.method === "DELETE" && onDelete) return onDelete(url.pathname);
    if (req.method === "DELETE") return new Response(null, { status: 200 });
    if (req.method === "PATCH" && onPatch) return onPatch(url.pathname, await req.json());
    if (req.method === "PATCH") {
      return Response.json({ member: { id: "m-x", userId: "u-x", role: "admin" } });
    }
    return new Response(null, { status: 404 });
  });

  const REGISTRY = {
    get: async (_key: string, _opts?: unknown) =>
      workspaceRecord === null ? null : { ...workspaceRecord, name: "acme" },
    put: async () => undefined,
  };

  return { AUTH: auth, DB: database(db), REGISTRY } as unknown as Env;
}

const sessionHeaders = { cookie: "session=x" };

describe("GET /v1/workspaces/:workspace/members", () => {
  it("returns members for a session member", async () => {
    const env = makeEnv({
      sessionUser: MEMBER,
      memberships: [{ organizationId: "org-1", organizationSlug: "acme", role: "member" }],
    });
    const res = await app.request("/v1/workspaces/acme/members", { headers: sessionHeaders }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: Record<string, unknown>[] };
    expect(body.members).toHaveLength(1);
    expect(body.members[0]).not.toHaveProperty("id");
  });

  it("includes opaque member ids for an admin/owner", async () => {
    const env = makeEnv();
    const res = await app.request("/v1/workspaces/acme/members", { headers: sessionHeaders }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: Record<string, unknown>[] };
    expect(body.members[0]).toHaveProperty("id", "m-admin");
  });

  it("404s a non-member session", async () => {
    const env = makeEnv({ memberships: [] });
    const res = await app.request("/v1/workspaces/acme/members", { headers: sessionHeaders }, env);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "workspace_not_found",
    );
  });

  it("403s a bearer token with a coded error", async () => {
    const env = makeEnv();
    const res = await app.request(
      "/v1/workspaces/acme/members",
      { headers: { Authorization: "Bearer up_acme_whatever" } },
      env,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "members_requires_session",
    );
  });

  it("401s with neither a bearer token nor a session", async () => {
    const env = makeEnv({ sessionUser: null });
    const res = await app.request("/v1/workspaces/acme/members", {}, env);
    expect(res.status).toBe(401);
  });

  // Issue #613 phase 3 review finding 1: a Better Auth bearer-session caller
  // (the `bearer()` plugin, apps/auth/src/auth.ts — a device-flow/CLI session
  // with no cookie) must succeed here exactly like a cookie session. The stub
  // AUTH's `get-session` doesn't care whether it was reached via `cookie` or
  // `authorization` (session-auth.ts's `resolveSessionUser` forwards both
  // unconditionally), so a non-`up_` bearer is the fixture for a Better Auth
  // session token.
  it("succeeds for a Better Auth bearer session with no cookie (direct canonical call)", async () => {
    const getSessionCalls = { count: 0 };
    const env = makeEnv({ getSessionCalls });
    const res = await app.request(
      "/v1/workspaces/acme/members",
      { headers: { Authorization: "Bearer better-auth-session-token" } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: Record<string, unknown>[] };
    expect(body.members[0]).toHaveProperty("id", "m-admin");
    expect(getSessionCalls.count).toBe(1);
  });
});

describe("GET /v1/workspaces/:workspace/people", () => {
  it("hides invites from a non-admin member", async () => {
    const env = makeEnv({
      sessionUser: MEMBER,
      memberships: [{ organizationId: "org-1", organizationSlug: "acme", role: "member" }],
      invites: [{ id: "i1", email: "x@y.com", role: "member", status: "pending", expiresAt: null }],
    });
    const res = await app.request("/v1/workspaces/acme/people", { headers: sessionHeaders }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { canManage: boolean; invites: unknown[] };
    expect(body.canManage).toBe(false);
    expect(body.invites).toEqual([]);
  });

  it("includes invites for an admin in one authz pass", async () => {
    const env = makeEnv({
      invites: [{ id: "i1", email: "x@y.com", role: "member", status: "pending", expiresAt: null }],
    });
    const res = await app.request("/v1/workspaces/acme/people", { headers: sessionHeaders }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { canManage: boolean; invites: unknown[]; role: string };
    expect(body.canManage).toBe(true);
    expect(body.role).toBe("admin");
    expect(body.invites).toHaveLength(1);
  });

  it("403s a bearer token", async () => {
    const env = makeEnv();
    const res = await app.request(
      "/v1/workspaces/acme/people",
      { headers: { Authorization: "Bearer up_acme_whatever" } },
      env,
    );
    expect(res.status).toBe(403);
  });
});

describe("session-only admin routes (invites list/revoke, member remove/role)", () => {
  it("GET /invites: admin session works, non-admin member 403s, non-member 404s", async () => {
    const adminEnv = makeEnv({
      invites: [{ id: "i1", email: "x@y.com", role: "member", status: "pending", expiresAt: null }],
    });
    const adminRes = await app.request(
      "/v1/workspaces/acme/invites",
      { headers: sessionHeaders },
      adminEnv,
    );
    expect(adminRes.status).toBe(200);
    expect(((await adminRes.json()) as { invites: unknown[] }).invites).toHaveLength(1);

    const memberEnv = makeEnv({
      sessionUser: MEMBER,
      memberships: [{ organizationId: "org-1", organizationSlug: "acme", role: "member" }],
    });
    const memberRes = await app.request(
      "/v1/workspaces/acme/invites",
      { headers: sessionHeaders },
      memberEnv,
    );
    expect(memberRes.status).toBe(403);
    expect(((await memberRes.json()) as { error: { code: string } }).error.code).toBe(
      "workspace_admin_required",
    );

    const nonMemberEnv = makeEnv({ memberships: [] });
    const nonMemberRes = await app.request(
      "/v1/workspaces/acme/invites",
      { headers: sessionHeaders },
      nonMemberEnv,
    );
    expect(nonMemberRes.status).toBe(404);
  });

  it("GET /invites: bearer token 403s (no bearer capability minted for this route)", async () => {
    const env = makeEnv();
    const res = await app.request(
      "/v1/workspaces/acme/invites",
      { headers: { Authorization: "Bearer up_acme_whatever" } },
      env,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "members_requires_session",
    );
  });

  it("DELETE /invites/:id: admin session revokes", async () => {
    let deletedPath: string | undefined;
    const env = makeEnv({
      onDelete: (path) => {
        deletedPath = path;
        return new Response(null, { status: 200 });
      },
    });
    const res = await app.request(
      "/v1/workspaces/acme/invites/inv-1",
      { method: "DELETE", headers: sessionHeaders },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(deletedPath).toBe("/internal/orgs/acme/invites/inv-1");
  });

  it("DELETE /members/:memberId: admin session removes a member", async () => {
    const env = makeEnv();
    const res = await app.request(
      "/v1/workspaces/acme/members/m-2",
      { method: "DELETE", headers: sessionHeaders },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("PATCH /members/:memberId: admin session changes role", async () => {
    const env = makeEnv({
      onPatch: (_path, body) =>
        Response.json({
          member: { id: "m-2", userId: "u-2", role: (body as { role: string }).role },
        }),
    });
    const res = await app.request(
      "/v1/workspaces/acme/members/m-2",
      {
        method: "PATCH",
        headers: { ...sessionHeaders, "content-type": "application/json" },
        body: JSON.stringify({ role: "admin" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ member: { id: "m-2", userId: "u-2", role: "admin" } });
  });

  // Was named "...400s before any AUTH call" — false: `sessionAdminGate`
  // (get-session + /internal/memberships) runs before `memberRoleUpdateHandler`
  // ever validates `role`, so AUTH calls do happen ahead of the 400. Renamed
  // to describe only what's actually guaranteed: the invalid role never
  // reaches the auth worker's own member-role PATCH (CodeRabbit PR #617
  // review finding 6).
  it("PATCH /members/:memberId: invalid role 400s and never reaches the auth worker PATCH", async () => {
    let patched = false;
    const env = makeEnv({
      onPatch: () => {
        patched = true;
        return Response.json({ member: {} });
      },
    });
    const res = await app.request(
      "/v1/workspaces/acme/members/m-2",
      {
        method: "PATCH",
        headers: { ...sessionHeaders, "content-type": "application/json" },
        body: JSON.stringify({ role: "owner" }),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect(patched).toBe(false);
  });
});

describe("POST /v1/workspaces/:workspace/invites (dual governance auth)", () => {
  it("governance token with workspace:invite works (bearer-path parity)", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const { token } = await createToken(db as unknown as D1Database, {
      workspace: "acme",
      scopes: ["workspace:invite"],
      mintedByUserId: "user-minter",
    });
    const env = makeEnv({ db });
    const res = await app.request(
      "/v1/workspaces/acme/invites",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ email: "t@example.com" }),
      },
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { invitation: { email: string } };
    expect(body.invitation.email).toBe("t@example.com");
  });

  it("token with the wrong scope (workspace:manage only) 403s", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const { token } = await createToken(db as unknown as D1Database, {
      workspace: "acme",
      scopes: ["workspace:manage"],
      mintedByUserId: "user-minter",
    });
    const env = makeEnv({ db });
    const res = await app.request(
      "/v1/workspaces/acme/invites",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ email: "t@example.com" }),
      },
      env,
    );
    expect(res.status).toBe(403);
  });

  it("admin session works", async () => {
    const env = makeEnv();
    const res = await app.request(
      "/v1/workspaces/acme/invites",
      {
        method: "POST",
        headers: { ...sessionHeaders, "content-type": "application/json" },
        body: JSON.stringify({ email: "t@example.com" }),
      },
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { invitation: { email: string } };
    expect(body.invitation.email).toBe("t@example.com");
  });

  it("member-not-admin session 403s", async () => {
    const env = makeEnv({
      sessionUser: MEMBER,
      memberships: [{ organizationId: "org-1", organizationSlug: "acme", role: "member" }],
    });
    const res = await app.request(
      "/v1/workspaces/acme/invites",
      {
        method: "POST",
        headers: { ...sessionHeaders, "content-type": "application/json" },
        body: JSON.stringify({ email: "t@example.com" }),
      },
      env,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "workspace_admin_required",
    );
  });

  it("non-member session 404s", async () => {
    const env = makeEnv({ memberships: [] });
    const res = await app.request(
      "/v1/workspaces/acme/invites",
      {
        method: "POST",
        headers: { ...sessionHeaders, "content-type": "application/json" },
        body: JSON.stringify({ email: "t@example.com" }),
      },
      env,
    );
    expect(res.status).toBe(404);
  });

  // Issue #613 phase 3 review finding 1: a Better Auth bearer session (no
  // `up_` prefix, no cookie) hitting this canonical route directly must
  // resolve via session auth, not the D1 governance-token path — same
  // `up_`-prefix discrimination `workspaceManageAuth` already uses.
  it("admin session presented as a Better Auth bearer (no cookie) works", async () => {
    const env = makeEnv();
    const res = await app.request(
      "/v1/workspaces/acme/invites",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer better-auth-session-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ email: "bearer-session@example.com" }),
      },
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { invitation: { email: string } };
    expect(body.invitation.email).toBe("bearer-session@example.com");
  });
});

// Issue #869 phase B: workspace-admin "join" invite links.
describe("POST /v1/workspaces/:workspace/invite-links", () => {
  it("mints a kind:'member' link for an admin session", async () => {
    const env = makeEnv();
    const res = await app.request(
      "/v1/workspaces/acme/invite-links",
      {
        method: "POST",
        headers: { ...sessionHeaders, "content-type": "application/json" },
        body: JSON.stringify({ label: "for the design team" }),
      },
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      workspace: string;
      id: string;
      pageId: string;
      label: string;
      url: string;
      expiresAt: string;
    };
    expect(body.workspace).toBe("acme");
    expect(body.label).toBe("for the design team");
    expect(body.pageId).toMatch(/^upi_/);
    expect(body.url).toContain(body.pageId);
    expect(body.url).toContain("#code=");
    // The plaintext code is never persisted — only the show-once URL carries it.
    expect(JSON.stringify(body)).not.toContain("code_hash");
  });

  // Issue #876: default expiry is 7 days (not the CLI-enrollment 2h
  // default), and default max uses is unlimited (null, useCount 0).
  it("defaults to a 7-day expiry and unlimited uses when expiresIn/maxUses are omitted", async () => {
    const before = Date.now();
    const env = makeEnv();
    const res = await app.request(
      "/v1/workspaces/acme/invite-links",
      {
        method: "POST",
        headers: { ...sessionHeaders, "content-type": "application/json" },
        body: "{}",
      },
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      expiresAt: string;
      maxUses: number | null;
      useCount: number;
    };
    const deltaMs = Date.parse(body.expiresAt) - before;
    // Within a few seconds of exactly 7 days — tolerant of test wall-clock drift.
    expect(Math.abs(deltaMs - 7 * 24 * 60 * 60 * 1000)).toBeLessThan(10_000);
    expect(body.maxUses).toBeNull();
    expect(body.useCount).toBe(0);
  });

  it('mints a non-expiring link when expiresIn is "never"', async () => {
    const env = makeEnv();
    const res = await app.request(
      "/v1/workspaces/acme/invite-links",
      {
        method: "POST",
        headers: { ...sessionHeaders, "content-type": "application/json" },
        body: JSON.stringify({ expiresIn: "never" }),
      },
      env,
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { expiresAt: string | null }).expiresAt).toBeNull();
  });

  it("mints a non-expiring link when expiresIn is null", async () => {
    const env = makeEnv();
    const res = await app.request(
      "/v1/workspaces/acme/invite-links",
      {
        method: "POST",
        headers: { ...sessionHeaders, "content-type": "application/json" },
        body: JSON.stringify({ expiresIn: null }),
      },
      env,
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { expiresAt: string | null }).expiresAt).toBeNull();
  });

  it("mints a link with an explicit expiresIn (seconds) and maxUses", async () => {
    const before = Date.now();
    const env = makeEnv();
    const res = await app.request(
      "/v1/workspaces/acme/invite-links",
      {
        method: "POST",
        headers: { ...sessionHeaders, "content-type": "application/json" },
        body: JSON.stringify({ expiresIn: 3600, maxUses: 5 }),
      },
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { expiresAt: string; maxUses: number };
    expect(Math.abs(Date.parse(body.expiresAt) - before - 3600 * 1000)).toBeLessThan(10_000);
    expect(body.maxUses).toBe(5);
  });

  it("400s for an expiresIn below the minimum", async () => {
    const env = makeEnv();
    const res = await app.request(
      "/v1/workspaces/acme/invite-links",
      {
        method: "POST",
        headers: { ...sessionHeaders, "content-type": "application/json" },
        body: JSON.stringify({ expiresIn: 60 }),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "invalid_expires_in",
    );
  });

  it("400s for an expiresIn above the maximum", async () => {
    const env = makeEnv();
    const res = await app.request(
      "/v1/workspaces/acme/invite-links",
      {
        method: "POST",
        headers: { ...sessionHeaders, "content-type": "application/json" },
        body: JSON.stringify({ expiresIn: 91 * 24 * 60 * 60 }),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "invalid_expires_in",
    );
  });

  it("400s for a non-integer/non-'never' expiresIn", async () => {
    const env = makeEnv();
    const res = await app.request(
      "/v1/workspaces/acme/invite-links",
      {
        method: "POST",
        headers: { ...sessionHeaders, "content-type": "application/json" },
        body: JSON.stringify({ expiresIn: "sometime" }),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "invalid_expires_in",
    );
  });

  it("400s for a zero or negative maxUses", async () => {
    const env = makeEnv();
    const res = await app.request(
      "/v1/workspaces/acme/invite-links",
      {
        method: "POST",
        headers: { ...sessionHeaders, "content-type": "application/json" },
        body: JSON.stringify({ maxUses: 0 }),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_max_uses");
  });

  it("defaults label to null when omitted", async () => {
    const env = makeEnv();
    const res = await app.request(
      "/v1/workspaces/acme/invite-links",
      {
        method: "POST",
        headers: { ...sessionHeaders, "content-type": "application/json" },
        body: "{}",
      },
      env,
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { label: unknown }).label).toBeNull();
  });

  it("400s for an invalid label", async () => {
    const env = makeEnv();
    const res = await app.request(
      "/v1/workspaces/acme/invite-links",
      {
        method: "POST",
        headers: { ...sessionHeaders, "content-type": "application/json" },
        body: JSON.stringify({ label: "" }),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_label");
  });

  it("403s with member_cap_reached when the workspace is at cap, and mints no row", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const env = makeEnv({ db, memberCapDenied: true });
    const res = await app.request(
      "/v1/workspaces/acme/invite-links",
      {
        method: "POST",
        headers: { ...sessionHeaders, "content-type": "application/json" },
        body: "{}",
      },
      env,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "member_cap_reached",
    );
    const list = await app.request(
      "/v1/workspaces/acme/invite-links",
      { headers: sessionHeaders },
      makeEnv({ db }),
    );
    expect(((await list.json()) as { links: unknown[] }).links).toHaveLength(0);
  });

  it("non-admin member session 403s", async () => {
    const env = makeEnv({
      sessionUser: MEMBER,
      memberships: [{ organizationId: "org-1", organizationSlug: "acme", role: "member" }],
    });
    const res = await app.request(
      "/v1/workspaces/acme/invite-links",
      {
        method: "POST",
        headers: { ...sessionHeaders, "content-type": "application/json" },
        body: "{}",
      },
      env,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "workspace_admin_required",
    );
  });

  it("non-member session 404s", async () => {
    const env = makeEnv({ memberships: [] });
    const res = await app.request(
      "/v1/workspaces/acme/invite-links",
      {
        method: "POST",
        headers: { ...sessionHeaders, "content-type": "application/json" },
        body: "{}",
      },
      env,
    );
    expect(res.status).toBe(404);
  });

  it("bearer token 403s (no bearer capability for this route)", async () => {
    const env = makeEnv();
    const res = await app.request(
      "/v1/workspaces/acme/invite-links",
      { method: "POST", headers: { Authorization: "Bearer up_acme_whatever" }, body: "{}" },
      env,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "members_requires_session",
    );
  });

  // Review finding 5: minting a member-kind link for a workspace mid-deletion
  // must 404, same existence rule `loadEditableWorkspace` (routes/admin-ui.ts)
  // already applies to the admin-minted token-kind links.
  it("404s minting for a soft-deleted workspace, and mints no row", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const env = makeEnv({
      db,
      workspaceRecord: { provider: "r2", bucket: "test", deletedAt: "2026-08-01T00:00:00.000Z" },
    });
    const res = await app.request(
      "/v1/workspaces/acme/invite-links",
      {
        method: "POST",
        headers: { ...sessionHeaders, "content-type": "application/json" },
        body: "{}",
      },
      env,
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "workspace_not_found",
    );
    const list = await app.request(
      "/v1/workspaces/acme/invite-links",
      { headers: sessionHeaders },
      makeEnv({ db }),
    );
    expect(((await list.json()) as { links: unknown[] }).links).toHaveLength(0);
  });

  it("404s minting for a purged-tombstone workspace", async () => {
    const env = makeEnv({
      workspaceRecord: { status: "purged", name: "acme", purgedAt: "2026-08-15T00:00:00.000Z" },
    });
    const res = await app.request(
      "/v1/workspaces/acme/invite-links",
      {
        method: "POST",
        headers: { ...sessionHeaders, "content-type": "application/json" },
        body: "{}",
      },
      env,
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "workspace_not_found",
    );
  });

  it("404s minting for a workspace with no registry record at all", async () => {
    const env = makeEnv({ workspaceRecord: null });
    const res = await app.request(
      "/v1/workspaces/acme/invite-links",
      {
        method: "POST",
        headers: { ...sessionHeaders, "content-type": "application/json" },
        body: "{}",
      },
      env,
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/workspaces/:workspace/invite-links + DELETE .../:id", () => {
  async function mint(db: SqliteD1, label?: string) {
    const res = await app.request(
      "/v1/workspaces/acme/invite-links",
      {
        method: "POST",
        headers: { ...sessionHeaders, "content-type": "application/json" },
        body: JSON.stringify(label ? { label } : {}),
      },
      makeEnv({ db }),
    );
    return (await res.json()) as { id: string; pageId: string };
  }

  it("lists only outstanding kind:'member' links, isolated per workspace", async () => {
    const db = new SqliteD1(MIGRATIONS);
    await mint(db, "one");
    await mint(db, "two");

    const res = await app.request(
      "/v1/workspaces/acme/invite-links",
      { headers: sessionHeaders },
      makeEnv({ db }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { links: { label: string | null; kind?: string }[] };
    expect(body.links.map((l) => l.label).sort()).toEqual(["one", "two"]);
    // code_hash (or the plaintext code) is never exposed by the list.
    expect(JSON.stringify(body)).not.toContain("code_hash");
  });

  // Issue #876: the list surfaces maxUses/useCount/nullable expiresAt so a
  // standing link is auditable at a glance.
  it("includes maxUses, useCount, and a nullable expiresAt per link", async () => {
    const db = new SqliteD1(MIGRATIONS);
    await app.request(
      "/v1/workspaces/acme/invite-links",
      {
        method: "POST",
        headers: { ...sessionHeaders, "content-type": "application/json" },
        body: JSON.stringify({ label: "capped", maxUses: 3 }),
      },
      makeEnv({ db }),
    );
    await app.request(
      "/v1/workspaces/acme/invite-links",
      {
        method: "POST",
        headers: { ...sessionHeaders, "content-type": "application/json" },
        body: JSON.stringify({ label: "standing", expiresIn: "never" }),
      },
      makeEnv({ db }),
    );

    const res = await app.request(
      "/v1/workspaces/acme/invite-links",
      { headers: sessionHeaders },
      makeEnv({ db }),
    );
    const body = (await res.json()) as {
      links: {
        label: string | null;
        maxUses: number | null;
        useCount: number;
        expiresAt: string | null;
      }[];
    };
    const capped = body.links.find((l) => l.label === "capped");
    const standing = body.links.find((l) => l.label === "standing");
    expect(capped).toEqual(
      expect.objectContaining({ maxUses: 3, useCount: 0, expiresAt: expect.any(String) }),
    );
    expect(standing).toEqual(
      expect.objectContaining({ maxUses: null, useCount: 0, expiresAt: null }),
    );
  });

  // Review finding 5 explicitly leaves list/revoke unguarded — useful during
  // a soft-delete's grace period (unlike mint, which 404s: see the "POST"
  // describe block above).
  it("list still works for a soft-deleted workspace's outstanding links", async () => {
    const db = new SqliteD1(MIGRATIONS);
    await mint(db, "minted-while-live");

    const res = await app.request(
      "/v1/workspaces/acme/invite-links",
      { headers: sessionHeaders },
      makeEnv({
        db,
        workspaceRecord: { provider: "r2", bucket: "test", deletedAt: "2026-08-01T00:00:00.000Z" },
      }),
    );
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { links: { label: string | null }[] }).links.map((l) => l.label),
    ).toEqual(["minted-while-live"]);
  });

  it("revoke still works for a soft-deleted workspace", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const link = await mint(db, "revoke-me-while-deleted");

    const del = await app.request(
      `/v1/workspaces/acme/invite-links/${link.id}`,
      { method: "DELETE", headers: sessionHeaders },
      makeEnv({
        db,
        workspaceRecord: { provider: "r2", bucket: "test", deletedAt: "2026-08-01T00:00:00.000Z" },
      }),
    );
    expect(del.status).toBe(200);
  });

  it("revoke deletes the link so it no longer appears in the list", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const link = await mint(db, "revoke-me");

    const del = await app.request(
      `/v1/workspaces/acme/invite-links/${link.id}`,
      { method: "DELETE", headers: sessionHeaders },
      makeEnv({ db }),
    );
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true, id: link.id });

    const list = await app.request(
      "/v1/workspaces/acme/invite-links",
      { headers: sessionHeaders },
      makeEnv({ db }),
    );
    expect(((await list.json()) as { links: unknown[] }).links).toHaveLength(0);
  });

  it("revoke 404s for an unknown id", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const res = await app.request(
      "/v1/workspaces/acme/invite-links/nope",
      { method: "DELETE", headers: sessionHeaders },
      makeEnv({ db }),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "invite_link_not_found",
    );
  });

  it("list: non-admin member 403s, non-member 404s, bearer 403s", async () => {
    const db = new SqliteD1(MIGRATIONS);
    await mint(db, "one");

    const memberRes = await app.request(
      "/v1/workspaces/acme/invite-links",
      { headers: sessionHeaders },
      makeEnv({
        db,
        sessionUser: MEMBER,
        memberships: [{ organizationId: "org-1", organizationSlug: "acme", role: "member" }],
      }),
    );
    expect(memberRes.status).toBe(403);

    const nonMemberRes = await app.request(
      "/v1/workspaces/acme/invite-links",
      { headers: sessionHeaders },
      makeEnv({ db, memberships: [] }),
    );
    expect(nonMemberRes.status).toBe(404);

    const bearerRes = await app.request(
      "/v1/workspaces/acme/invite-links",
      { headers: { Authorization: "Bearer up_acme_whatever" } },
      makeEnv({ db }),
    );
    expect(bearerRes.status).toBe(403);
  });
});

describe("/me alias forwards (issue #613 phase 3)", () => {
  it("GET /me/workspaces/:name/members matches the canonical shape", async () => {
    const env = makeEnv();
    const canonical = await app.request(
      "/v1/workspaces/acme/members",
      { headers: sessionHeaders },
      env,
    );
    const alias = await app.request(
      "/me/workspaces/acme/members",
      { headers: sessionHeaders },
      env,
    );
    expect(alias.status).toBe(200);
    expect(await alias.json()).toEqual(await canonical.json());
  });

  it("GET /me/workspaces/:name/people matches the canonical shape", async () => {
    const env = makeEnv({
      invites: [{ id: "i1", email: "x@y.com", role: "member", status: "pending", expiresAt: null }],
    });
    const canonical = await app.request(
      "/v1/workspaces/acme/people",
      { headers: sessionHeaders },
      env,
    );
    const alias = await app.request("/me/workspaces/acme/people", { headers: sessionHeaders }, env);
    expect(alias.status).toBe(200);
    expect(await alias.json()).toEqual(await canonical.json());
  });

  it("POST /me/workspaces/:name/invites matches the canonical shape", async () => {
    const env = makeEnv();
    const res = await app.request(
      "/me/workspaces/acme/invites",
      {
        method: "POST",
        headers: { ...sessionHeaders, "content-type": "application/json" },
        body: JSON.stringify({ email: "alias@example.com" }),
      },
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { invitation: { email: string } };
    expect(body.invitation.email).toBe("alias@example.com");
  });

  it("resolves the session exactly once per forwarded request (members)", async () => {
    const getSessionCalls = { count: 0 };
    const env = makeEnv({ getSessionCalls });
    const res = await app.request("/me/workspaces/acme/members", { headers: sessionHeaders }, env);
    expect(res.status).toBe(200);
    expect(getSessionCalls.count).toBe(1);
  });

  it("resolves the session exactly once per forwarded request (invites POST)", async () => {
    const getSessionCalls = { count: 0 };
    const env = makeEnv({ getSessionCalls });
    const res = await app.request(
      "/me/workspaces/acme/invites",
      {
        method: "POST",
        headers: { ...sessionHeaders, "content-type": "application/json" },
        body: JSON.stringify({ email: "once@example.com" }),
      },
      env,
    );
    expect(res.status).toBe(201);
    expect(getSessionCalls.count).toBe(1);
  });

  it("membership rejection still applies to the forwarded alias (non-member -> 404)", async () => {
    const env = makeEnv({ memberships: [] });
    const res = await app.request("/me/workspaces/acme/members", { headers: sessionHeaders }, env);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "workspace_not_found",
    );
  });

  it("DELETE /me/workspaces/:name/members/:memberId still works via the forward", async () => {
    const env = makeEnv();
    const res = await app.request(
      "/me/workspaces/acme/members/m-2",
      { method: "DELETE", headers: sessionHeaders },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("PATCH /me/workspaces/:name/members/:memberId still works via the forward", async () => {
    const env = makeEnv({
      onPatch: (_path, body) =>
        Response.json({
          member: { id: "m-2", userId: "u-2", role: (body as { role: string }).role },
        }),
    });
    const res = await app.request(
      "/me/workspaces/acme/members/m-2",
      {
        method: "PATCH",
        headers: { ...sessionHeaders, "content-type": "application/json" },
        body: JSON.stringify({ role: "admin" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ member: { id: "m-2", userId: "u-2", role: "admin" } });
  });

  it("DELETE /me/workspaces/:name/invites/:id still works via the forward", async () => {
    const env = makeEnv();
    const res = await app.request(
      "/me/workspaces/acme/invites/inv-1",
      { method: "DELETE", headers: sessionHeaders },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("GET /me/workspaces/:name/invites still works via the forward", async () => {
    const env = makeEnv({
      invites: [{ id: "i1", email: "x@y.com", role: "member", status: "pending", expiresAt: null }],
    });
    const res = await app.request("/me/workspaces/acme/invites", { headers: sessionHeaders }, env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { invites: unknown[] }).invites).toHaveLength(1);
  });

  // Issue #613 phase 3 review finding 1: `/me`'s own `sessionAuth` +
  // `requireSessionUser` middleware validates a Better Auth bearer session
  // (no cookie) exactly like a cookie session and presets the resolved
  // userId. `forwardToWorkspaceMembers` re-dispatches with the ORIGINAL
  // request headers intact — including that `Authorization: Bearer …`
  // header — so `sessionMemberGate` must consult the preset before ever
  // branching on the (irrelevant, already-authenticated) bearer header.
  it("GET /me/workspaces/:name/members succeeds for a caller who authenticated with a Better Auth bearer session (no cookie)", async () => {
    const getSessionCalls = { count: 0 };
    const env = makeEnv({ getSessionCalls });
    const res = await app.request(
      "/me/workspaces/acme/members",
      { headers: { Authorization: "Bearer better-auth-session-token" } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: Record<string, unknown>[] };
    expect(body.members[0]).toHaveProperty("id", "m-admin");
    // Exactly one get-session call: /me's own middleware resolves it once,
    // and the preset means the forwarded canonical request never re-resolves.
    expect(getSessionCalls.count).toBe(1);
  });

  it("POST /me/workspaces/:name/invites succeeds for a caller who authenticated with a Better Auth bearer session (no cookie)", async () => {
    const getSessionCalls = { count: 0 };
    const env = makeEnv({ getSessionCalls });
    const res = await app.request(
      "/me/workspaces/acme/invites",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer better-auth-session-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ email: "forwarded-bearer@example.com" }),
      },
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { invitation: { email: string } };
    expect(body.invitation.email).toBe("forwarded-bearer@example.com");
    expect(getSessionCalls.count).toBe(1);
  });
});
