import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { respondError } from "../error-response";
import { tokens } from "./tokens";

const USER = { id: "u-1", email: "a@b.com", name: "Ada", role: "user" };
const ORG = { id: "org-acme", slug: "acme", name: "Acme" };

function stubAuth(handler: (req: Request) => Response | Promise<Response>): Pick<Fetcher, "fetch"> {
  return {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      return handler(req);
    }) as Fetcher["fetch"],
  };
}

/** Captures the last auth_tokens INSERT bind values so tests can assert on them. */
function captureDb(): { insert?: unknown[] } & { db: D1Database } {
  const box: { insert?: unknown[] } = {};
  const db = {
    prepare(_sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            run: async () => {
              box.insert = values;
              return { meta: { changes: 1 }, success: true, results: [] };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return Object.assign(box, { db });
}

interface EnvOpts {
  user?: typeof USER | null;
  memberships?: { organizationId: string; organizationSlug: string; role: string }[];
  org?: typeof ORG | null;
  workspaces?: Record<string, object>;
  db?: D1Database;
  /** When set, the WRITE_LIMITER binding reports this success value. */
  writeLimitOk?: boolean;
  /** Seeds the `ghlogin:<userId>` cache the workspace suggestion reads. */
  githubLogin?: string;
}

function stubEnv(opts: EnvOpts = {}): Env {
  const {
    user = USER,
    memberships = [{ organizationId: ORG.id, organizationSlug: ORG.slug, role: "member" }],
    org = ORG,
    workspaces = { acme: { provider: "r2", bucket: "b" } },
    db = captureDb().db,
    writeLimitOk,
    githubLogin,
  } = opts;

  const auth = stubAuth(async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/api/auth/get-session") {
      return new Response(JSON.stringify(user ? { session: {}, user } : null), { status: 200 });
    }
    if (url.pathname === "/internal/memberships") {
      return new Response(JSON.stringify(memberships), { status: 200 });
    }
    if (url.pathname.startsWith("/internal/orgs/")) {
      if (!org) return new Response(JSON.stringify({ error: {} }), { status: 404 });
      return new Response(JSON.stringify({ organization: org }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });

  const registry = {
    get: (async (key: string) => {
      const name = key.startsWith("ws:") ? key.slice(3) : key;
      return workspaces[name] ?? null;
    }) as unknown as KVNamespace["get"],
  };

  const WRITE_LIMITER =
    writeLimitOk === undefined ? undefined : { limit: async () => ({ success: writeLimitOk }) };

  const GITHUB_CACHE = {
    get: async (key: string) => (githubLogin && key === `ghlogin:${USER.id}` ? githubLogin : null),
    put: async () => {},
  };

  return {
    AUTH: auth,
    REGISTRY: registry,
    DB: db,
    WRITE_LIMITER,
    GITHUB_CACHE,
  } as unknown as Env;
}

function app() {
  return new Hono<{ Bindings: Env }>()
    .route("/v1/tokens", tokens)
    .onError((err, c) => respondError(c, err));
}

function post(env: Env, body: unknown, headers: Record<string, string> = {}) {
  return app().request(
    "/v1/tokens",
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sess", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    env,
  );
}

const oneGrant = { grants: [{ workspace: "acme", scopes: ["files:read", "files:write"] }] };

describe("POST /v1/tokens auth", () => {
  it("401s without a session", async () => {
    const res = await post(stubEnv({ user: null }), oneGrant);
    expect(res.status).toBe(401);
  });

  it("403s when the user is not a member of the workspace's org", async () => {
    const res = await post(stubEnv({ memberships: [] }), oneGrant);
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "workspace_forbidden" },
    });
  });

  it("403s (same code) when the workspace KV record does not exist", async () => {
    const res = await post(stubEnv({ workspaces: {} }), oneGrant);
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "workspace_forbidden" },
    });
  });

  it("403s when the workspace has no backing org yet", async () => {
    const res = await post(stubEnv({ org: null }), oneGrant);
    expect(res.status).toBe(403);
  });

  it("503s (not 403) when the membership lookup fails — outage, not 'no access'", async () => {
    // AUTH binding answers get-session (valid user) but 500s on /internal/memberships.
    const auth = stubAuth((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/auth/get-session") {
        return new Response(JSON.stringify({ session: {}, user: USER }), { status: 200 });
      }
      if (url.pathname.startsWith("/internal/orgs/")) {
        return new Response(JSON.stringify({ organization: ORG }), { status: 200 });
      }
      return new Response("boom", { status: 500 });
    });
    const env = {
      AUTH: auth,
      REGISTRY: { get: async () => ({ provider: "r2", bucket: "b" }) },
      DB: captureDb().db,
    } as unknown as Env;
    const res = await post(env, oneGrant);
    expect(res.status).toBe(503);
  });
});

describe("POST /v1/tokens request validation", () => {
  it("400s on multiple grants (not yet supported)", async () => {
    const res = await post(stubEnv(), {
      grants: [
        { workspace: "acme", scopes: ["files:read"] },
        { workspace: "beta", scopes: ["files:read"] },
      ],
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "multi_grant_unsupported" },
    });
  });

  it("400s on an empty grants array", async () => {
    const res = await post(stubEnv(), { grants: [] });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "invalid_grants" },
    });
  });

  it("400s on a missing grants field", async () => {
    const res = await post(stubEnv(), { label: "x" });
    expect(res.status).toBe(400);
  });

  it("400s on an invalid workspace name", async () => {
    const res = await post(stubEnv(), {
      grants: [{ workspace: "Bad Name", scopes: ["files:read"] }],
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "invalid_workspace" },
    });
  });

  it("400s on an unknown scope", async () => {
    const res = await post(stubEnv(), { grants: [{ workspace: "acme", scopes: ["files:nuke"] }] });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "invalid_scopes" },
    });
  });

  it("400s on an out-of-range ttlSeconds", async () => {
    const res = await post(stubEnv(), { ...oneGrant, ttlSeconds: 99 * 365 * 24 * 60 * 60 });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "invalid_ttl" },
    });
  });
});

describe("GET /v1/tokens (workspace listing)", () => {
  it("401s without a session", async () => {
    const res = await app().request(
      "/v1/tokens",
      { headers: { authorization: "Bearer x" } },
      stubEnv({ user: null }),
    );
    expect(res.status).toBe(401);
  });

  // Issue #506: a name to prefill, offered only to an account with nothing to
  // pick from. It is a hint — nothing is created and no name is claimed.
  it("suggests a workspace derived from the GitHub login when the account has none", async () => {
    const env = stubEnv({ memberships: [], workspaces: {}, githubLogin: "Octocat" });
    const res = await app().request("/v1/tokens", { headers: { authorization: "Bearer s" } }, env);
    expect(await res.json()).toEqual({ workspaces: [], suggestedWorkspace: "octocat" });
  });

  it("omits the suggestion when the derived name is already taken", async () => {
    const env = stubEnv({
      memberships: [],
      workspaces: { octocat: { provider: "r2", bucket: "b" } },
      githubLogin: "Octocat",
    });
    const res = await app().request("/v1/tokens", { headers: { authorization: "Bearer s" } }, env);
    expect(await res.json()).toEqual({ workspaces: [] });
  });

  it("omits the suggestion when no GitHub login resolves", async () => {
    const env = stubEnv({ memberships: [], workspaces: {} });
    const res = await app().request("/v1/tokens", { headers: { authorization: "Bearer s" } }, env);
    expect(await res.json()).toEqual({ workspaces: [] });
  });

  it("does not suggest for an account that already has a workspace", async () => {
    const env = stubEnv({ githubLogin: "Octocat" });
    const res = await app().request("/v1/tokens", { headers: { authorization: "Bearer s" } }, env);
    const body = (await res.json()) as { suggestedWorkspace?: string };
    expect(body.suggestedWorkspace).toBeUndefined();
  });

  it("lists memberships whose workspace still exists in KV", async () => {
    const env = stubEnv({
      memberships: [
        { organizationId: "org-acme", organizationSlug: "acme", role: "owner" },
        { organizationId: "org-gone", organizationSlug: "gone", role: "member" },
      ],
      workspaces: { acme: { provider: "r2", bucket: "b" } },
    });
    const res = await app().request(
      "/v1/tokens",
      { headers: { authorization: "Bearer sess" } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaces: { workspace: string; role: string }[] };
    // "gone" is filtered out (no KV record); "acme" carries its org role.
    expect(body.workspaces).toEqual([{ workspace: "acme", role: "owner" }]);
  });
});

describe("POST /v1/tokens mint", () => {
  it("mints a workspace token and records the minting user", async () => {
    const cap = captureDb();
    const res = await post(stubEnv({ db: cap.db }), {
      ...oneGrant,
      label: "zach-laptop",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      token: string;
      workspace: string;
      scopes: string[];
      label: string | null;
      expiresAt: string | null;
    };
    expect(body.token).toMatch(/^up_acme_/);
    expect(body.workspace).toBe("acme");
    expect(body.scopes).toEqual(["files:read", "files:write"]);
    expect(body.label).toBe("zach-laptop");
    expect(body.expiresAt).toBeTruthy();
    // INSERT binds: id, workspace, token_hash, label, scopes, created_at,
    // expires_at, minting_user_id — the last is the session user's id.
    expect(cap.insert?.[7]).toBe(USER.id);
    expect(cap.insert?.[1]).toBe("acme");
  });

  it("defaults scopes to read+write when the grant omits them", async () => {
    const res = await post(stubEnv(), { grants: [{ workspace: "acme" }] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { scopes: string[] };
    expect(body.scopes).toEqual(["files:read", "files:write"]);
  });

  it("429s when the workspace's write rate limit is exhausted", async () => {
    const cap = captureDb();
    const res = await post(stubEnv({ db: cap.db, writeLimitOk: false }), oneGrant);
    expect(res.status).toBe(429);
    // Rate-limited before any token row is written.
    expect(cap.insert).toBeUndefined();
  });

  it("mints when the rate limiter allows the request", async () => {
    const res = await post(stubEnv({ writeLimitOk: true }), oneGrant);
    expect(res.status).toBe(201);
  });
});

describe("POST /v1/tokens operator scopes", () => {
  it("400s when a non-admin requests an operator scope", async () => {
    const res = await post(stubEnv({ user: { ...USER, role: "user" } }), {
      grants: [{ workspace: "acme", scopes: ["operator:read"] }],
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "invalid_scopes" },
    });
  });

  it("allows an admin user to mint operator:write alongside file scopes", async () => {
    const cap = captureDb();
    const res = await post(stubEnv({ user: { ...USER, role: "admin" }, db: cap.db }), {
      grants: [{ workspace: "acme", scopes: ["files:read", "operator:write"] }],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { scopes: string[] };
    expect(body.scopes).toEqual(["files:read", "operator:write"]);
  });

  it("allows a multi-role admin user (comma-separated role) to mint operator scopes", async () => {
    const res = await post(stubEnv({ user: { ...USER, role: "admin,support" } }), {
      grants: [{ workspace: "acme", scopes: ["operator:read"] }],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { scopes: string[] };
    expect(body.scopes).toEqual(["operator:read"]);
  });

  it("never includes operator scopes in the default mint", async () => {
    const res = await post(stubEnv({ user: { ...USER, role: "admin" } }), {
      grants: [{ workspace: "acme" }],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { scopes: string[] };
    expect(body.scopes).toEqual(["files:read", "files:write"]);
  });
});

describe("POST /v1/tokens workspace-governance scopes (#262)", () => {
  it("400s when an org member (not admin/owner) requests workspace:invite", async () => {
    const res = await post(
      stubEnv({
        memberships: [{ organizationId: ORG.id, organizationSlug: ORG.slug, role: "member" }],
      }),
      { grants: [{ workspace: "acme", scopes: ["workspace:invite"] }] },
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "invalid_scopes" },
    });
  });

  it("201s when the caller is an org admin in the target workspace", async () => {
    const res = await post(
      stubEnv({
        memberships: [{ organizationId: ORG.id, organizationSlug: ORG.slug, role: "admin" }],
      }),
      { grants: [{ workspace: "acme", scopes: ["workspace:invite"] }] },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { scopes: string[] };
    expect(body.scopes).toEqual(["workspace:invite"]);
  });

  it("201s when the caller is an org owner in the target workspace", async () => {
    const res = await post(
      stubEnv({
        memberships: [{ organizationId: ORG.id, organizationSlug: ORG.slug, role: "owner" }],
      }),
      { grants: [{ workspace: "acme", scopes: ["workspace:manage"] }] },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { scopes: string[] };
    expect(body.scopes).toEqual(["workspace:manage"]);
  });

  it("400s for a platform admin without an org admin/owner role in the workspace — no bypass", async () => {
    const res = await post(
      stubEnv({
        user: { ...USER, role: "admin" },
        memberships: [{ organizationId: ORG.id, organizationSlug: ORG.slug, role: "member" }],
      }),
      { grants: [{ workspace: "acme", scopes: ["workspace:invite"] }] },
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "invalid_scopes" },
    });
  });

  it("never includes workspace scopes in the default mint, even for an org owner", async () => {
    const res = await post(
      stubEnv({
        memberships: [{ organizationId: ORG.id, organizationSlug: ORG.slug, role: "owner" }],
      }),
      { grants: [{ workspace: "acme" }] },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { scopes: string[] };
    expect(body.scopes).toEqual(["files:read", "files:write"]);
  });

  it("requires both gates for a mixed operator:* + workspace:* request", async () => {
    // Org owner (workspace gate passes) but non-admin platform role (operator gate fails).
    const failsOperatorGate = await post(
      stubEnv({
        user: { ...USER, role: "user" },
        memberships: [{ organizationId: ORG.id, organizationSlug: ORG.slug, role: "owner" }],
      }),
      { grants: [{ workspace: "acme", scopes: ["operator:read", "workspace:invite"] }] },
    );
    expect(failsOperatorGate.status).toBe(400);

    // Platform admin (operator gate passes) but plain member (workspace gate fails).
    const failsWorkspaceGate = await post(
      stubEnv({
        user: { ...USER, role: "admin" },
        memberships: [{ organizationId: ORG.id, organizationSlug: ORG.slug, role: "member" }],
      }),
      { grants: [{ workspace: "acme", scopes: ["operator:read", "workspace:invite"] }] },
    );
    expect(failsWorkspaceGate.status).toBe(400);

    // Both gates pass.
    const bothPass = await post(
      stubEnv({
        user: { ...USER, role: "admin" },
        memberships: [{ organizationId: ORG.id, organizationSlug: ORG.slug, role: "owner" }],
      }),
      { grants: [{ workspace: "acme", scopes: ["operator:read", "workspace:invite"] }] },
    );
    expect(bothPass.status).toBe(201);
    const body = (await bothPass.json()) as { scopes: string[] };
    expect(body.scopes).toEqual(["operator:read", "workspace:invite"]);
  });
});

const OWN_TOKEN: {
  id: string;
  workspace: string;
  token_hash: string;
  label: string;
  scopes: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  minting_user_id: string;
} = {
  id: "tok-1",
  workspace: "acme",
  token_hash: "abc123",
  label: "ci",
  scopes: JSON.stringify(["files:read", "files:write"]),
  created_at: "2026-08-01T00:00:00.000Z",
  expires_at: "2026-11-01T00:00:00.000Z",
  revoked_at: null,
  minting_user_id: USER.id,
};

function issuedDb(tokens: (typeof OWN_TOKEN)[]) {
  const rows = tokens.map((t) => ({ ...t }));
  const db = {
    prepare(sql: string) {
      const normalized = sql.replace(/\s+/g, " ");
      return {
        bind(...values: unknown[]) {
          return {
            all: async () => {
              const [userId, now] = values as [string, string];
              return {
                results: rows.filter(
                  (row) =>
                    row.minting_user_id === userId &&
                    row.revoked_at === null &&
                    (row.expires_at === null || row.expires_at > now),
                ),
              };
            },
            first: async () => {
              const [id, userId] = values as [string, string];
              return (
                rows.find(
                  (row) =>
                    row.id === id && row.minting_user_id === userId && row.revoked_at === null,
                ) ?? null
              );
            },
            run: async () => {
              if (!normalized.includes("UPDATE auth_tokens")) {
                return { meta: { changes: 0 }, success: true };
              }
              const [, id, userId] = values as [string, string, string];
              const row = rows.find(
                (r) => r.id === id && r.minting_user_id === userId && r.revoked_at === null,
              );
              if (row) row.revoked_at = new Date().toISOString();
              return { meta: { changes: row ? 1 : 0 }, success: true };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { rows, db };
}

describe("GET /v1/tokens/issued", () => {
  it("401s without a session", async () => {
    const res = await app().request(
      "/v1/tokens/issued",
      { headers: { authorization: "Bearer x" } },
      stubEnv({ user: null }),
    );
    expect(res.status).toBe(401);
  });

  it("lists only tokens this user minted", async () => {
    const { db } = issuedDb([OWN_TOKEN]);
    const res = await app().request(
      "/v1/tokens/issued",
      { headers: { authorization: "Bearer s" } },
      stubEnv({ db }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tokens: [
        {
          id: "tok-1",
          workspace: "acme",
          label: "ci",
          scopes: ["files:read", "files:write"],
          createdAt: OWN_TOKEN.created_at,
          expiresAt: OWN_TOKEN.expires_at,
        },
      ],
    });
  });
});

describe("DELETE /v1/tokens/:id", () => {
  it("404s for a token this user did not mint", async () => {
    const { db } = issuedDb([{ ...OWN_TOKEN, minting_user_id: "other" }]);
    const res = await app().request(
      "/v1/tokens/tok-1",
      { method: "DELETE", headers: { authorization: "Bearer s" } },
      stubEnv({ db }),
    );
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "token_not_found" },
    });
  });

  it("revokes an owned token", async () => {
    const { db, rows } = issuedDb([OWN_TOKEN]);
    const res = await app().request(
      "/v1/tokens/tok-1",
      { method: "DELETE", headers: { authorization: "Bearer s" } },
      stubEnv({ db }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "tok-1", workspace: "acme", revoked: true });
    expect(rows[0].revoked_at).toBeTruthy();
  });

  it("429s before revoking when the write limiter is exhausted", async () => {
    const { db, rows } = issuedDb([OWN_TOKEN]);
    const res = await app().request(
      "/v1/tokens/tok-1",
      { method: "DELETE", headers: { authorization: "Bearer s" } },
      stubEnv({ db, writeLimitOk: false }),
    );
    expect(res.status).toBe(429);
    expect(rows[0].revoked_at).toBeNull();
  });
});
