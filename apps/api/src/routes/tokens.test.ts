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
}

function stubEnv(opts: EnvOpts = {}): Env {
  const {
    user = USER,
    memberships = [{ organizationId: ORG.id, organizationSlug: ORG.slug, role: "member" }],
    org = ORG,
    workspaces = { acme: { provider: "r2", bucket: "b" } },
    db = captureDb().db,
  } = opts;

  const auth = stubAuth((req) => {
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

  return { AUTH: auth, REGISTRY: registry, DB: db } as unknown as Env;
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
});
