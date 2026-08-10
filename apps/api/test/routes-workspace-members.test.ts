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
  "migrations/20260712230000_token_minting_user.sql",
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
    if (req.method === "DELETE" && onDelete) return onDelete(url.pathname);
    if (req.method === "DELETE") return new Response(null, { status: 200 });
    if (req.method === "PATCH" && onPatch) return onPatch(url.pathname, await req.json());
    if (req.method === "PATCH") {
      return Response.json({ member: { id: "m-x", userId: "u-x", role: "admin" } });
    }
    return new Response(null, { status: 404 });
  });

  return { AUTH: auth, DB: database(db) } as unknown as Env;
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

  it("PATCH /members/:memberId: invalid role 400s before any AUTH call", async () => {
    const env = makeEnv();
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
