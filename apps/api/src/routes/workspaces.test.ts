import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { SqliteD1 } from "../../test/helpers/sqlite-d1";
import { createToken } from "../auth-db";
import { respondError } from "../error-response";
import { workspaces } from "./workspaces";

const USER = { id: "u1", email: "z@x.com", name: "Zach" };

const MIGRATIONS = [
  "migrations/20260710120000_auth.sql",
  "migrations/20260712230000_token_minting_user.sql",
];

interface EnvOpts {
  session?: boolean;
  sessionUser?: typeof USER & { role?: string };
  githubLinked?: boolean;
  memberships?: { organizationId: string; organizationSlug: string; role: string }[];
  kvRecords?: Record<string, object>;
  provision?: () => { status: number; organization?: { id: string; slug: string; name: string } };
  onDeleteOrg?: (slug: string) => void;
  putThrows?: boolean;
  wsCreateLimiterAllows?: boolean;
}

function stubAuth(handler: (req: Request) => Response | Promise<Response>): Pick<Fetcher, "fetch"> {
  return {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      return handler(req);
    }) as Fetcher["fetch"],
  };
}

function stubEnv(opts: EnvOpts = {}): Env {
  const {
    session = true,
    sessionUser = USER,
    githubLinked = true,
    memberships = [],
    kvRecords = {},
    provision = () => ({
      status: 201,
      organization: { id: "org-1", slug: "zachbot", name: "zachbot" },
    }),
    onDeleteOrg,
    putThrows = false,
    wsCreateLimiterAllows,
  } = opts;

  const auth = stubAuth((req) => {
    const url = new URL(req.url);
    if (url.pathname === "/api/auth/get-session") {
      return new Response(JSON.stringify(session ? { session: {}, user: sessionUser } : null), {
        status: 200,
      });
    }
    if (url.pathname === "/internal/users/u1/github-linked") {
      return new Response(JSON.stringify({ githubLinked }), { status: 200 });
    }
    if (url.pathname === "/internal/memberships") {
      return new Response(JSON.stringify(memberships), { status: 200 });
    }
    if (
      req.method === "GET" &&
      url.pathname.startsWith("/internal/orgs/") &&
      url.pathname !== "/internal/orgs/provision"
    ) {
      const slug = decodeURIComponent(url.pathname.slice("/internal/orgs/".length));
      const membership = memberships.find((m) => m.organizationSlug === slug);
      if (!membership) return new Response(null, { status: 404 });
      return Response.json({
        organization: { id: membership.organizationId, slug, name: slug },
      });
    }
    if (url.pathname === "/internal/orgs/provision") {
      const result = provision();
      if (result.status === 409) {
        return new Response(JSON.stringify({ error: {} }), { status: 409 });
      }
      return new Response(JSON.stringify({ organization: result.organization }), {
        status: result.status,
      });
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/internal/orgs/")) {
      onDeleteOrg?.(decodeURIComponent(url.pathname.slice("/internal/orgs/".length)));
      return new Response(null, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });

  const puts: [string, string][] = [];
  const registry = {
    get: (async (key: string) => {
      const name = key.startsWith("ws:") ? key.slice(3) : key;
      return kvRecords[name] ?? null;
    }) as unknown as KVNamespace["get"],
    put: (async (key: string, value: string) => {
      if (putThrows) throw new Error("kv put failed");
      puts.push([key, value]);
    }) as unknown as KVNamespace["put"],
  };

  const wsCreateLimiter =
    wsCreateLimiterAllows === undefined
      ? undefined
      : ({
          limit: (async () => ({ success: wsCreateLimiterAllows })) as unknown,
        } as unknown as Env["WS_CREATE_LIMITER"]);

  return Object.assign({ AUTH: auth, REGISTRY: registry, __puts: puts } as unknown as Env, {
    __puts: puts,
    ...(wsCreateLimiter ? { WS_CREATE_LIMITER: wsCreateLimiter } : {}),
  });
}

function app() {
  return new Hono<{ Bindings: Env }>()
    .route("/v1/workspaces", workspaces)
    .onError((err, c) => respondError(c, err));
}

function post(env: Env, body: unknown) {
  return app().request(
    "/v1/workspaces",
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sess" },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe("POST /v1/workspaces", () => {
  it("401s with no session", async () => {
    const res = await post(stubEnv({ session: false }), { name: "zachbot" });
    expect(res.status).toBe(401);
  });

  it("400s on invalid and reserved names", async () => {
    const bad = await post(stubEnv(), { name: "Bad_Name" });
    expect(bad.status).toBe(400);
    expect((await bad.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "invalid_workspace_name" },
    });

    const reserved = await post(stubEnv(), { name: "admin" });
    expect(reserved.status).toBe(400);
    expect((await reserved.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "reserved_workspace_name" },
    });
  });

  it("403s code github_required when no GitHub account is linked", async () => {
    const res = await post(stubEnv({ githubLinked: false, wsCreateLimiterAllows: true }), {
      name: "zachbot",
    });
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "github_required" },
    });
  });

  it("429s when the workspace-create limiter denies", async () => {
    const res = await post(stubEnv({ wsCreateLimiterAllows: false }), { name: "zachbot" });
    expect(res.status).toBe(429);
  });

  it("checks the create-rate-limit before the GitHub-linked gate", async () => {
    // Limiter denies AND GitHub isn't linked — rate limit must win, proving
    // the limiter check runs first and doesn't require the AUTH round-trip.
    const res = await post(stubEnv({ wsCreateLimiterAllows: false, githubLinked: false }), {
      name: "zachbot",
    });
    expect(res.status).toBe(429);
  });

  it("403s code workspace_cap_reached at 3 owned self-serve workspaces", async () => {
    const memberships = [
      { organizationId: "o1", organizationSlug: "one", role: "owner" },
      { organizationId: "o2", organizationSlug: "two", role: "owner" },
      { organizationId: "o3", organizationSlug: "three", role: "owner" },
    ];
    const kvRecords = {
      one: { selfServe: true },
      two: { selfServe: true },
      three: { selfServe: true },
    };
    const res = await post(stubEnv({ memberships, kvRecords }), { name: "zachbot" });
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "workspace_cap_reached" },
    });
  });

  it("does not count non-self-serve (BYO) owned workspaces toward the cap", async () => {
    const memberships = [
      { organizationId: "o1", organizationSlug: "one", role: "owner" },
      { organizationId: "o2", organizationSlug: "two", role: "owner" },
      { organizationId: "o3", organizationSlug: "three", role: "owner" },
    ];
    const kvRecords = {
      one: { provider: "r2", bucket: "b" },
      two: { provider: "r2", bucket: "b" },
      three: { provider: "r2", bucket: "b" },
    };
    const res = await post(stubEnv({ memberships, kvRecords }), { name: "zachbot" });
    expect(res.status).toBe(201);
  });

  it("409s code workspace_name_taken when the KV record exists", async () => {
    const res = await post(stubEnv({ kvRecords: { zachbot: { provider: "r2", bucket: "b" } } }), {
      name: "zachbot",
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "workspace_name_taken" },
    });
  });

  it("409s code workspace_name_taken when org provisioning returns 409", async () => {
    const res = await post(stubEnv({ provision: () => ({ status: 409 }) }), { name: "zachbot" });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "workspace_name_taken" },
    });
  });

  it("creates org then KV record and returns 201", async () => {
    const env = stubEnv({
      provision: () => ({
        status: 201,
        organization: { id: "org-1", slug: "zachbot", name: "zachbot" },
      }),
    });
    const res = await post(env, { name: "zachbot" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      workspace: { name: string; publicBaseUrl: string; selfServe: boolean };
    };
    expect(body.workspace).toEqual({
      name: "zachbot",
      publicBaseUrl: "https://storage.uploads.sh",
      selfServe: true,
    });

    const puts = (env as unknown as { __puts: [string, string][] }).__puts;
    expect(puts).toHaveLength(1);
    const [key, value] = puts[0];
    expect(key).toBe("ws:zachbot");
    const parsed = JSON.parse(value);
    expect(parsed).toMatchObject({
      selfServe: true,
      createdByUserId: "u1",
      prefix: "zachbot/",
      provider: "r2",
    });
    expect(parsed.createdAt).toBeTruthy();
  });

  it("rolls back the org when the KV write throws", async () => {
    let deletedSlug: string | undefined;
    const env = stubEnv({
      putThrows: true,
      onDeleteOrg: (slug) => {
        deletedSlug = slug;
      },
    });
    const res = await post(env, { name: "zachbot" });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(deletedSlug).toBe("zachbot");
  });
});

function del(env: Env, name: string) {
  return app().request(
    `/v1/workspaces/${name}`,
    { method: "DELETE", headers: { authorization: "Bearer sess" } },
    env,
  );
}

function restore(env: Env, name: string) {
  return app().request(
    `/v1/workspaces/${name}/restore`,
    { method: "POST", headers: { authorization: "Bearer sess" } },
    env,
  );
}

const OWNED_RECORD = {
  provider: "r2",
  bucket: "uploads-default",
  selfServe: true,
  createdByUserId: "u1",
};

describe("DELETE /v1/workspaces/:name (self-serve, #249)", () => {
  it("soft-deletes: stamps deletedAt/purgeAt, data untouched", async () => {
    const env = stubEnv({ kvRecords: { zachbot: OWNED_RECORD } });
    const res = await del(env, "zachbot");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      mode: string;
      deletedAt: string;
      purgeAt: string;
    };
    expect(body).toMatchObject({ ok: true, workspace: "zachbot", mode: "soft" });
    expect(body.deletedAt).toBeTruthy();
    expect(body.purgeAt).toBeTruthy();

    const puts = (env as unknown as { __puts: [string, string][] }).__puts;
    expect(puts).toHaveLength(1);
    const [key, value] = puts[0];
    expect(key).toBe("ws:zachbot");
    const parsed = JSON.parse(value);
    expect(parsed).toMatchObject({
      ...OWNED_RECORD,
      deletedAt: body.deletedAt,
      purgeAt: body.purgeAt,
    });
  });

  it("403s for a non-owner (different createdByUserId)", async () => {
    const env = stubEnv({
      kvRecords: { zachbot: { ...OWNED_RECORD, createdByUserId: "someone-else" } },
    });
    const res = await del(env, "zachbot");
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "not_owner" },
    });
  });

  it("403s for a non-self-serve (BYO) record even if createdByUserId matched", async () => {
    const env = stubEnv({
      kvRecords: { zachbot: { provider: "r2", bucket: "b", createdByUserId: "u1" } },
    });
    const res = await del(env, "zachbot");
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "not_owner" },
    });
  });

  it("404s for an unknown workspace", async () => {
    const env = stubEnv({});
    const res = await del(env, "no-such-workspace");
    expect(res.status).toBe(404);
  });

  it("404s for a purged tombstone", async () => {
    const env = stubEnv({
      kvRecords: {
        zachbot: { status: "purged", name: "zachbot", purgedAt: new Date().toISOString() },
      },
    });
    const res = await del(env, "zachbot");
    expect(res.status).toBe(404);
  });

  it("409s already_deleted on a repeat delete", async () => {
    const env = stubEnv({
      kvRecords: {
        zachbot: {
          ...OWNED_RECORD,
          deletedAt: new Date().toISOString(),
          purgeAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
        },
      },
    });
    const res = await del(env, "zachbot");
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "already_deleted" },
    });
  });

  it("blocks deleting the communal workspace", async () => {
    const env = stubEnv({ kvRecords: { default: OWNED_RECORD } });
    const res = await del(env, "default");
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "protected_workspace" },
    });
  });
});

describe("POST /v1/workspaces/:name/restore (self-serve, #249)", () => {
  it("restores within the grace window, clearing both fields", async () => {
    const env = stubEnv({
      kvRecords: {
        zachbot: {
          ...OWNED_RECORD,
          deletedAt: new Date().toISOString(),
          purgeAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
        },
      },
    });
    const res = await restore(env, "zachbot");
    expect(res.status).toBe(200);

    const puts = (env as unknown as { __puts: [string, string][] }).__puts;
    expect(puts).toHaveLength(1);
    const parsed = JSON.parse(puts[0][1]);
    expect(parsed.deletedAt).toBeUndefined();
    expect(parsed.purgeAt).toBeUndefined();
    expect(parsed).toMatchObject(OWNED_RECORD);
  });

  it("410s grace_expired once purgeAt has passed", async () => {
    const env = stubEnv({
      kvRecords: {
        zachbot: {
          ...OWNED_RECORD,
          deletedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
          purgeAt: new Date(Date.now() - 1000).toISOString(),
        },
      },
    });
    const res = await restore(env, "zachbot");
    expect(res.status).toBe(410);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "grace_expired" },
    });
  });

  it("409s not_deleted for a live workspace", async () => {
    const env = stubEnv({ kvRecords: { zachbot: OWNED_RECORD } });
    const res = await restore(env, "zachbot");
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "not_deleted" },
    });
  });

  it("403s for a non-owner", async () => {
    const env = stubEnv({
      kvRecords: {
        zachbot: {
          ...OWNED_RECORD,
          createdByUserId: "someone-else",
          deletedAt: new Date().toISOString(),
          purgeAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
        },
      },
    });
    const res = await restore(env, "zachbot");
    expect(res.status).toBe(403);
  });
});

describe("self-serve delete/restore extended to org owner (#265)", () => {
  const NOT_CREATOR_RECORD = { ...OWNED_RECORD, createdByUserId: "someone-else" };
  const ORG_OWNER_MEMBERSHIPS = [
    { organizationId: "org-1", organizationSlug: "zachbot", role: "owner" },
  ];
  const ORG_ADMIN_MEMBERSHIPS = [
    { organizationId: "org-1", organizationSlug: "zachbot", role: "admin" },
  ];
  const ORG_MEMBER_MEMBERSHIPS = [
    { organizationId: "org-1", organizationSlug: "zachbot", role: "member" },
  ];

  it("org owner (non-creator) can delete", async () => {
    const env = stubEnv({
      kvRecords: { zachbot: NOT_CREATOR_RECORD },
      memberships: ORG_OWNER_MEMBERSHIPS,
    });
    const res = await del(env, "zachbot");
    expect(res.status).toBe(200);
  });

  it("org owner (non-creator) can restore", async () => {
    const env = stubEnv({
      kvRecords: {
        zachbot: {
          ...NOT_CREATOR_RECORD,
          deletedAt: new Date().toISOString(),
          purgeAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
        },
      },
      memberships: ORG_OWNER_MEMBERSHIPS,
    });
    const res = await restore(env, "zachbot");
    expect(res.status).toBe(200);
  });

  it("403s org admin (non-owner, non-creator)", async () => {
    const env = stubEnv({
      kvRecords: { zachbot: NOT_CREATOR_RECORD },
      memberships: ORG_ADMIN_MEMBERSHIPS,
    });
    const res = await del(env, "zachbot");
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "not_owner" },
    });
  });

  it("403s a plain member", async () => {
    const env = stubEnv({
      kvRecords: { zachbot: NOT_CREATOR_RECORD },
      memberships: ORG_MEMBER_MEMBERSHIPS,
    });
    const res = await del(env, "zachbot");
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "not_owner" },
    });
  });

  it("403s a platform admin (session user role=admin) without an org role", async () => {
    const env = stubEnv({
      kvRecords: { zachbot: NOT_CREATOR_RECORD },
      memberships: [],
      sessionUser: { ...USER, role: "admin" },
    });
    const res = await del(env, "zachbot");
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "not_owner" },
    });
  });

  it("the record creator still works even with no org membership recorded", async () => {
    const env = stubEnv({ kvRecords: { zachbot: OWNED_RECORD }, memberships: [] });
    const res = await del(env, "zachbot");
    expect(res.status).toBe(200);
  });

  it("blocks a non-self-serve (BYO) workspace even for the org owner", async () => {
    const env = stubEnv({
      kvRecords: { zachbot: { provider: "r2", bucket: "b", createdByUserId: "someone-else" } },
      memberships: ORG_OWNER_MEMBERSHIPS,
    });
    const res = await del(env, "zachbot");
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "not_owner" },
    });
  });

  it("a workspace:manage-scoped bearer token still cannot delete (session-only surface)", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const { token } = await createToken(db as unknown as D1Database, {
      workspace: "zachbot",
      scopes: ["workspace:manage"],
    });
    const env = stubEnv({
      session: false,
      kvRecords: { zachbot: NOT_CREATOR_RECORD },
      memberships: ORG_OWNER_MEMBERSHIPS,
    });
    const res = await app().request(
      "/v1/workspaces/zachbot",
      { method: "DELETE", headers: { authorization: `Bearer ${token}` } },
      env,
    );
    // DELETE/restore are wired to plain sessionAuth (never workspaceManageAuth),
    // so an up_-shaped bearer is just an unrecognized session credential — 401,
    // never a successful delete.
    expect(res.status).toBe(401);
  });
});
