/**
 * GET/DELETE /v1/workspaces/:name/tokens (issue #262 Task 3) — self-serve
 * token governance, dual-authed: EITHER a session user with org role
 * admin/owner in :name (stubAuth idiom from workspaces.test.ts) OR a D1
 * `workspace:manage`-scoped token bound to :name (createToken idiom from
 * workspace-governance-invite.test.ts).
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { SqliteD1, database } from "../../test/helpers/sqlite-d1";
import { createToken } from "../auth-db";
import { respondError } from "../error-response";
import { workspaces } from "./workspaces";

const MIGRATIONS = [
  "migrations/20260710120000_auth.sql",
  "migrations/20260712230000_token_minting_user.sql",
];

const USER = { id: "u1", email: "z@x.com", name: "Zach" };

function stubAuth(handler: (req: Request) => Response | Promise<Response>): Pick<Fetcher, "fetch"> {
  return {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      return handler(req);
    }) as Fetcher["fetch"],
  };
}

function appWith(opts: {
  db: SqliteD1;
  session?: boolean;
  role?: string;
  memberships?: { organizationId: string; organizationSlug: string; role: string }[];
}) {
  const {
    db,
    session = false,
    role = "admin",
    memberships = [{ organizationId: "org1", organizationSlug: "acme", role }],
  } = opts;
  const app = new Hono<{ Bindings: Env }>()
    .route("/v1/workspaces", workspaces)
    .onError((err, c) => respondError(c, err));
  const auth = stubAuth((req) => {
    const url = new URL(req.url);
    if (url.pathname === "/api/auth/get-session") {
      return new Response(JSON.stringify(session ? { session: {}, user: USER } : null), {
        status: 200,
      });
    }
    if (url.pathname === "/internal/memberships") {
      return new Response(JSON.stringify(memberships), { status: 200 });
    }
    if (url.pathname === "/internal/orgs/acme") {
      return Response.json({ organization: { id: "org1", slug: "acme", name: "Acme" } });
    }
    return new Response("not found", { status: 404 });
  });
  const env = { AUTH: auth, DB: database(db) } as unknown as Env;
  return { app, env };
}

function listReq(workspace: string, bearer?: string) {
  return new Request(`https://api.uploads.sh/v1/workspaces/${workspace}/tokens`, {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
}

function revokeReq(workspace: string, bearer: string | undefined, body: Record<string, unknown>) {
  return new Request(`https://api.uploads.sh/v1/workspaces/${workspace}/tokens`, {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

// Session-authed requests carry a Better Auth bearer session token (not a
// `up_<workspace>_…` token) on the Authorization header, mirroring
// workspaces.test.ts. workspaceManageAuth must route these through the
// session path, not the workspace-token path.
const SESSION_BEARER = "sess";

describe("GET /v1/workspaces/:name/tokens", () => {
  it("org admin session sees active D1 tokens, redacted", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const { record } = await createToken(db as unknown as D1Database, {
      workspace: "acme",
      label: "ci-bot",
      scopes: ["workspace:manage"],
      mintedByUserId: "someone-else",
    });
    const { app, env } = appWith({ db, session: true, role: "admin" });
    const res = await app.request(listReq("acme", SESSION_BEARER), {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tokens: { label: string | null; hashPrefix: string }[] };
    expect(body.tokens).toHaveLength(1);
    expect(body.tokens[0]).toMatchObject({
      label: "ci-bot",
      hashPrefix: record.token_hash.slice(0, 8),
      scopes: ["workspace:manage"],
    });
    // Never the raw token value.
    expect(JSON.stringify(body)).not.toContain(record.token_hash);
  });

  it("org owner session also works", async () => {
    const db = new SqliteD1(MIGRATIONS);
    await createToken(db as unknown as D1Database, {
      workspace: "acme",
      scopes: ["workspace:manage"],
    });
    const { app, env } = appWith({ db, session: true, role: "owner" });
    const res = await app.request(listReq("acme", SESSION_BEARER), {}, env);
    expect(res.status).toBe(200);
  });

  it("plain member session gets 403", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const { app, env } = appWith({ db, session: true, role: "member" });
    const res = await app.request(listReq("acme", SESSION_BEARER), {}, env);
    expect(res.status).toBe(403);
  });

  it("no session at all gets 401", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const { app, env } = appWith({ db, session: false });
    const res = await app.request(listReq("acme"), {}, env);
    expect(res.status).toBe(401);
  });

  it("workspace:manage token works for its own workspace", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const { token } = await createToken(db as unknown as D1Database, {
      workspace: "acme",
      scopes: ["workspace:manage"],
    });
    await createToken(db as unknown as D1Database, {
      workspace: "acme",
      label: "another",
      scopes: ["workspace:manage"],
    });
    const { app, env } = appWith({ db });
    const res = await app.request(listReq("acme", token), {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tokens: unknown[] };
    // Both the caller's own token and the sibling token are D1 rows for this
    // workspace — both are listed.
    expect(body.tokens).toHaveLength(2);
  });

  it("workspace:manage token bound to a different workspace is rejected", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const { token } = await createToken(db as unknown as D1Database, {
      workspace: "other",
      scopes: ["workspace:manage"],
    });
    const { app, env } = appWith({ db });
    const res = await app.request(listReq("acme", token), {}, env);
    expect(res.status).toBe(403);
  });

  it("shaped-but-invalid up_ bearer is rejected even with a valid org-admin session (no fallback)", async () => {
    const db = new SqliteD1(MIGRATIONS);
    // Valid admin session available via cookies/get-session — but the
    // request explicitly presents a `up_`-shaped bearer that matches no
    // active token. Fail-closed: the bearer is authoritative, no silent
    // session fallback.
    const { app, env } = appWith({ db, session: true, role: "admin" });
    const res = await app.request(listReq("acme", "up_acme_notarealtoken"), {}, env);
    expect(res.status).toBe(401);
  });

  it("workspace:invite-only token gets 403 (wrong scope for this route)", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const { token } = await createToken(db as unknown as D1Database, {
      workspace: "acme",
      scopes: ["workspace:invite"],
    });
    const { app, env } = appWith({ db });
    const res = await app.request(listReq("acme", token), {}, env);
    expect(res.status).toBe(403);
  });
});

describe("DELETE /v1/workspaces/:name/tokens", () => {
  it("org admin session revokes by label and flips revoked_at", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const { record } = await createToken(db as unknown as D1Database, {
      workspace: "acme",
      label: "stale-ci",
      scopes: ["workspace:manage"],
    });
    const { app, env } = appWith({ db, session: true, role: "admin" });
    const res = await app.request(
      revokeReq("acme", SESSION_BEARER, { label: "stale-ci" }),
      {},
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revoked: { label: string | null } };
    expect(body.revoked).toMatchObject({ label: "stale-ci" });

    const row = await db
      .prepare("SELECT revoked_at FROM auth_tokens WHERE id = ?")
      .bind(record.id)
      .first<{ revoked_at: string | null }>();
    expect(row?.revoked_at).not.toBeNull();
  });

  it("workspace:manage token revokes by hashPrefix, own workspace only", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const { token: managerToken } = await createToken(db as unknown as D1Database, {
      workspace: "acme",
      scopes: ["workspace:manage"],
    });
    const { record: victimRecord } = await createToken(db as unknown as D1Database, {
      workspace: "acme",
      label: "victim",
      scopes: ["workspace:invite"],
    });
    const { app, env } = appWith({ db });
    const res = await app.request(
      revokeReq("acme", managerToken, { hashPrefix: victimRecord.token_hash.slice(0, 12) }),
      {},
      env,
    );
    expect(res.status).toBe(200);
    const row = await db
      .prepare("SELECT revoked_at FROM auth_tokens WHERE id = ?")
      .bind(victimRecord.id)
      .first<{ revoked_at: string | null }>();
    expect(row?.revoked_at).not.toBeNull();
  });

  it("plain member session gets 403", async () => {
    const db = new SqliteD1(MIGRATIONS);
    await createToken(db as unknown as D1Database, {
      workspace: "acme",
      scopes: ["workspace:manage"],
    });
    const { app, env } = appWith({ db, session: true, role: "member" });
    const res = await app.request(revokeReq("acme", SESSION_BEARER, { label: "x" }), {}, env);
    expect(res.status).toBe(403);
  });

  it("workspace:invite-only token gets 403", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const { token } = await createToken(db as unknown as D1Database, {
      workspace: "acme",
      scopes: ["workspace:invite"],
    });
    const { app, env } = appWith({ db });
    const res = await app.request(revokeReq("acme", token, { label: "x" }), {}, env);
    expect(res.status).toBe(403);
  });

  it("no selector is a 400", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const { app, env } = appWith({ db, session: true, role: "admin" });
    const res = await app.request(revokeReq("acme", SESSION_BEARER, {}), {}, env);
    expect(res.status).toBe(400);
  });

  it("no match is a 404", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const { app, env } = appWith({ db, session: true, role: "admin" });
    const res = await app.request(revokeReq("acme", SESSION_BEARER, { label: "nope" }), {}, env);
    expect(res.status).toBe(404);
  });

  it("ambiguous label across multiple tokens is a 409", async () => {
    const db = new SqliteD1(MIGRATIONS);
    await createToken(db as unknown as D1Database, {
      workspace: "acme",
      label: "dup",
      scopes: ["workspace:manage"],
    });
    await createToken(db as unknown as D1Database, {
      workspace: "acme",
      label: "dup",
      scopes: ["workspace:invite"],
    });
    const { app, env } = appWith({ db, session: true, role: "admin" });
    const res = await app.request(revokeReq("acme", SESSION_BEARER, { label: "dup" }), {}, env);
    expect(res.status).toBe(409);
  });
});
