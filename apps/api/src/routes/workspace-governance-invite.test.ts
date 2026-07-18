/**
 * POST /v1/workspaces/:name/invites (issue #262) — token-authed invite via
 * `workspaceGovernanceAuth`. Follows the `admin-scoped-token.test.ts` idiom
 * (real SQLite-backed D1 via `createToken`) plus the `stubAuth` idiom from
 * `me.test.ts`/`workspaces.test.ts` for the AUTH service binding.
 */
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { SqliteD1, database } from "../../test/helpers/sqlite-d1";
import { createToken } from "../auth-db";
import { respondError } from "../error-response";
import { workspaces } from "./workspaces";

const MIGRATIONS = [
  "migrations/20260710120000_auth.sql",
  "migrations/20260712230000_token_minting_user.sql",
];

const MINTER_ID = "user-minter-1";

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
  onInvite?: (body: unknown) => Response | Promise<Response>;
  orgFound?: boolean;
}) {
  const { db, onInvite, orgFound = true } = opts;
  const app = new Hono<{ Bindings: Env }>()
    .route("/v1/workspaces", workspaces)
    .onError((err, c) => respondError(c, err));
  const auth = stubAuth(async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/internal/orgs/acme") {
      if (!orgFound) return new Response(null, { status: 404 });
      return Response.json({ organization: { id: "org1", slug: "acme", name: "Acme" } });
    }
    if (url.pathname === "/internal/invite" && req.method === "POST") {
      const body = await req.json();
      if (onInvite) return onInvite(body);
      return Response.json(
        {
          invitation: {
            id: "inv1",
            organizationId: "org1",
            email: (body as { email?: string }).email,
            role: "member",
            status: "pending",
          },
        },
        { status: 201 },
      );
    }
    return new Response(null, { status: 404 });
  });
  const env = { AUTH: auth, DB: database(db) } as unknown as Env;
  return { app, env };
}

function inviteRequest(workspace: string, bearer: string, body: Record<string, unknown> = {}) {
  return new Request(`https://api.uploads.sh/v1/workspaces/${workspace}/invites`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ email: "t@example.com", ...body }),
  });
}

describe("POST /v1/workspaces/:name/invites", () => {
  it("happy path: workspace:invite token invites, attributed to minting_user_id", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const { token } = await createToken(db as unknown as D1Database, {
      workspace: "acme",
      scopes: ["workspace:invite"],
      mintedByUserId: MINTER_ID,
    });
    let captured: unknown;
    const { app, env } = appWith({
      db,
      onInvite: (body) => {
        captured = body;
        return Response.json(
          { invitation: { id: "inv1", email: "t@example.com", status: "pending" } },
          { status: 201 },
        );
      },
    });
    const res = await app.request(inviteRequest("acme", token), {}, env);
    expect(res.status).toBe(201);
    expect(captured).toMatchObject({
      organizationSlug: "acme",
      email: "t@example.com",
      role: "member",
      inviterUserId: MINTER_ID,
    });
  });

  it("foreign-workspace token gets 403", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const { token } = await createToken(db as unknown as D1Database, {
      workspace: "other",
      scopes: ["workspace:invite"],
      mintedByUserId: MINTER_ID,
    });
    const { app, env } = appWith({ db });
    const res = await app.request(inviteRequest("acme", token), {}, env);
    expect(res.status).toBe(403);
  });

  it("minter demoted (auth worker stub rejects) surfaces the error", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const { token } = await createToken(db as unknown as D1Database, {
      workspace: "acme",
      scopes: ["workspace:invite"],
      mintedByUserId: MINTER_ID,
    });
    const { app, env } = appWith({
      db,
      onInvite: () => Response.json({ error: { code: "inviter_not_authorized" } }, { status: 403 }),
    });
    const res = await app.request(inviteRequest("acme", token), {}, env);
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "inviter_not_authorized" },
    });
  });

  it("file-scope token is rejected with 403", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const { token } = await createToken(db as unknown as D1Database, {
      workspace: "acme",
      scopes: ["files:read", "files:write"],
      mintedByUserId: MINTER_ID,
    });
    const { app, env } = appWith({ db });
    const res = await app.request(inviteRequest("acme", token), {}, env);
    expect(res.status).toBe(403);
  });

  it("operator-only token is rejected with 403", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const { token } = await createToken(db as unknown as D1Database, {
      workspace: "acme",
      scopes: ["operator:write"],
      mintedByUserId: MINTER_ID,
    });
    const { app, env } = appWith({ db });
    const res = await app.request(inviteRequest("acme", token), {}, env);
    expect(res.status).toBe(403);
  });

  it("revoked token is rejected with 401", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const { token, record } = await createToken(db as unknown as D1Database, {
      workspace: "acme",
      scopes: ["workspace:invite"],
      mintedByUserId: MINTER_ID,
    });
    await db
      .prepare(`UPDATE auth_tokens SET revoked_at = ? WHERE id = ?`)
      .bind(new Date().toISOString(), record.id)
      .run();
    const { app, env } = appWith({ db });
    const res = await app.request(inviteRequest("acme", token), {}, env);
    expect(res.status).toBe(401);
  });

  it("expired token is rejected with 401", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const { token } = await createToken(db as unknown as D1Database, {
      workspace: "acme",
      scopes: ["workspace:invite"],
      mintedByUserId: MINTER_ID,
      expiresAt: new Date(Date.now() - 1000),
    });
    const { app, env } = appWith({ db });
    const res = await app.request(inviteRequest("acme", token), {}, env);
    expect(res.status).toBe(401);
  });

  it("no auth header is rejected with 401", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const { app, env } = appWith({ db });
    const res = await app.request(
      new Request("https://api.uploads.sh/v1/workspaces/acme/invites", { method: "POST" }),
      {},
      env,
    );
    expect(res.status).toBe(401);
  });

  it("a governance token has zero file access — parseScopes stays fail-closed", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const { record } = await createToken(db as unknown as D1Database, {
      workspace: "acme",
      scopes: ["workspace:invite", "workspace:manage"],
      mintedByUserId: MINTER_ID,
    });
    // Import lazily to avoid pulling in unrelated route wiring at module load.
    const { parseScopes } = await import("../auth-db");
    expect(parseScopes(record.scopes)).toEqual([]);
  });
});
