import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { respondError } from "../error-response";
import { adminUi } from "./admin-ui";

const ADMIN_USER = { id: "u-admin", email: "admin@b.com", name: "Admin", role: "admin" };
const NON_ADMIN_USER = { id: "u-plain", email: "plain@b.com", name: "Plain", role: "user" };

function stubAuth(handler: (req: Request) => Response | Promise<Response>): Pick<Fetcher, "fetch"> {
  return {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      return handler(req);
    }) as Fetcher["fetch"],
  };
}

/** A single stub that answers get-session with `user`, and everything else via `onInternal`. */
function stubEnv(
  user: typeof ADMIN_USER | null,
  onInternal: (path: string, req: Request) => Response | Promise<Response>,
): Env {
  const auth = stubAuth((req) => {
    const url = new URL(req.url);
    if (url.pathname === "/api/auth/get-session") {
      return new Response(JSON.stringify(user ? { session: {}, user } : null), { status: 200 });
    }
    return onInternal(url.pathname, req);
  });
  return { AUTH: auth, REGISTRY: fakeKv([]) } as unknown as Env;
}

function fakeKv(names: string[]): Pick<KVNamespace, "list"> {
  return {
    list: (async () => ({
      keys: names.map((name) => ({ name: `ws:${name}` })),
      list_complete: true,
      cacheStatus: null,
    })) as unknown as KVNamespace["list"],
  };
}

function app() {
  return new Hono<{ Bindings: Env }>()
    .route("/admin-ui", adminUi)
    .onError((err, c) => respondError(c, err));
}

describe("admin-ui auth gate", () => {
  it("401s with no session", async () => {
    const env = stubEnv(null, () => new Response("{}"));
    const res = await app().request("/admin-ui/workspaces", {}, env);
    expect(res.status).toBe(401);
  });

  it("403s for a non-admin session", async () => {
    const env = stubEnv(NON_ADMIN_USER, () => new Response("{}"));
    const res = await app().request("/admin-ui/workspaces", {}, env);
    expect(res.status).toBe(403);
  });
});

describe("GET /admin-ui/workspaces", () => {
  it("lists KV workspaces joined with org summaries", async () => {
    const auth = stubAuth((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/auth/get-session") {
        return new Response(JSON.stringify({ session: {}, user: ADMIN_USER }), { status: 200 });
      }
      if (url.pathname === "/internal/orgs/acme") {
        return Response.json({
          organization: { id: "org1", slug: "acme", name: "acme" },
          memberCount: 2,
          pendingInviteCount: 1,
        });
      }
      return new Response(null, { status: 404 });
    });
    const env = { AUTH: auth, REGISTRY: fakeKv(["acme"]) } as unknown as Env;
    const res = await app().request("/admin-ui/workspaces", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workspaces: [
        {
          workspace: "acme",
          organization: { id: "org1", slug: "acme", name: "acme" },
          memberCount: 2,
          pendingInviteCount: 1,
        },
      ],
    });
  });
});

describe("POST /admin-ui/workspaces/:name/invites", () => {
  it("creates an invitation via the internal endpoint", async () => {
    const env = stubEnv(ADMIN_USER, (path, req) => {
      if (path === "/internal/orgs/acme") {
        return Response.json({ organization: { id: "org1", slug: "acme", name: "acme" } });
      }
      if (path === "/internal/invite") {
        expect(req.headers.get("x-uploads-internal")).toBe("1");
        return new Response(
          JSON.stringify({ invitation: { id: "inv1", email: "x@y.com", role: "member" } }),
          { status: 201 },
        );
      }
      return new Response(null, { status: 404 });
    });
    const res = await app().request(
      "/admin-ui/workspaces/acme/invites",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "x@y.com", role: "member" }),
      },
      env,
    );
    expect(res.status).toBe(201);
  });

  it("404s when no org exists for the workspace", async () => {
    const env = stubEnv(ADMIN_USER, () => new Response(null, { status: 404 }));
    const res = await app().request(
      "/admin-ui/workspaces/no-org/invites",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "x@y.com", role: "member" }),
      },
      env,
    );
    expect(res.status).toBe(404);
  });

  it("400s on an invalid email without calling the internal invite endpoint", async () => {
    let inviteCalled = false;
    const env = stubEnv(ADMIN_USER, (path) => {
      if (path === "/internal/orgs/acme") {
        return Response.json({ organization: { id: "org1", slug: "acme", name: "acme" } });
      }
      if (path === "/internal/invite") inviteCalled = true;
      return new Response(null, { status: 404 });
    });
    const res = await app().request(
      "/admin-ui/workspaces/acme/invites",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "not-an-email", role: "member" }),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect(inviteCalled).toBe(false);
  });

  it("403s for a non-admin session", async () => {
    const env = stubEnv(NON_ADMIN_USER, () => new Response(null, { status: 404 }));
    const res = await app().request(
      "/admin-ui/workspaces/acme/invites",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "x@y.com", role: "member" }),
      },
      env,
    );
    expect(res.status).toBe(403);
  });

  it("429s when the per-workspace write budget is exhausted", async () => {
    const env = stubEnv(ADMIN_USER, () => new Response(null, { status: 404 })) as Env & {
      WRITE_LIMITER: { limit: (opts: { key: string }) => Promise<{ success: boolean }> };
    };
    env.WRITE_LIMITER = { limit: async () => ({ success: false }) };
    const res = await app().request(
      "/admin-ui/workspaces/acme/invites",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "x@y.com", role: "member" }),
      },
      env,
    );
    expect(res.status).toBe(429);
  });
});

describe("POST /admin-ui/workspaces/:name/invite-links", () => {
  type Row = Record<string, unknown>;

  class FakeStatement {
    values: unknown[] = [];
    constructor(
      readonly db: FakeD1,
      readonly sql: string,
    ) {}
    bind(...values: unknown[]): FakeStatement {
      this.values = values;
      return this;
    }
    run(): Promise<D1Result> {
      this.db.enrollments.push({
        id: this.values[0],
        workspace: this.values[1],
        code_hash: this.values[2],
        label: this.values[3],
        scopes: this.values[4],
        created_at: this.values[5],
        expires_at: this.values[6],
        token_expires_at: this.values[7],
        used_at: null,
        page_id: this.values[8],
      });
      return Promise.resolve({ success: true } as unknown as D1Result);
    }
  }

  class FakeD1 {
    enrollments: Row[] = [];
    prepare(sql: string): FakeStatement {
      return new FakeStatement(this, sql);
    }
  }

  function envWithDb(
    user: typeof ADMIN_USER | null,
    registryNames: string[],
  ): Env & { DB: FakeD1 } {
    const base = stubEnv(user, () => new Response(null, { status: 404 }));
    const db = new FakeD1();
    return {
      ...base,
      REGISTRY: {
        get: (async (key: string) =>
          registryNames.some((n) => `ws:${n}` === key)
            ? "{}"
            : null) as unknown as KVNamespace["get"],
      } as unknown as KVNamespace,
      DB: db,
    } as unknown as Env & { DB: FakeD1 };
  }

  it("mints a redeemable code for an admin session", async () => {
    const env = envWithDb(ADMIN_USER, ["acme"]);
    const res = await app().request(
      "/admin-ui/workspaces/acme/invite-links",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      env,
    );
    expect(res.status).toBe(201);
    const payload = (await res.json()) as {
      workspace: string;
      code: string;
      pageId: string;
      url: string;
      scopes: string[];
      expiresAt: string;
    };
    expect(payload.workspace).toBe("acme");
    expect(payload.code).toMatch(/^upe_/);
    expect(payload.pageId).toMatch(/^upi_/);
    expect(payload.url).toContain(payload.pageId);
    expect(payload.url).toContain("#code=");
    expect(payload.scopes).toEqual(["files:read", "files:write"]);
    expect(env.DB.enrollments).toHaveLength(1);
  });

  it("401s with no session", async () => {
    const env = envWithDb(null, ["acme"]);
    const res = await app().request(
      "/admin-ui/workspaces/acme/invite-links",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("403s for a non-admin session", async () => {
    const env = envWithDb(NON_ADMIN_USER, ["acme"]);
    const res = await app().request(
      "/admin-ui/workspaces/acme/invite-links",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      env,
    );
    expect(res.status).toBe(403);
  });

  it("404s for an unknown workspace", async () => {
    const env = envWithDb(ADMIN_USER, []);
    const res = await app().request(
      "/admin-ui/workspaces/nope/invite-links",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      env,
    );
    expect(res.status).toBe(404);
  });

  it("400s for an empty label", async () => {
    const env = envWithDb(ADMIN_USER, ["acme"]);
    const res = await app().request(
      "/admin-ui/workspaces/acme/invite-links",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "" }),
      },
      env,
    );
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error?: { code?: string } };
    expect(payload.error?.code).toBe("invalid_label");
  });

  it("400s for a label over 100 characters", async () => {
    const env = envWithDb(ADMIN_USER, ["acme"]);
    const res = await app().request(
      "/admin-ui/workspaces/acme/invite-links",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "x".repeat(101) }),
      },
      env,
    );
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error?: { code?: string } };
    expect(payload.error?.code).toBe("invalid_label");
  });

  it("400s for invalid scopes", async () => {
    const env = envWithDb(ADMIN_USER, ["acme"]);
    const res = await app().request(
      "/admin-ui/workspaces/acme/invite-links",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scopes: ["not:a:real:scope"] }),
      },
      env,
    );
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error?: { code?: string } };
    expect(payload.error?.code).toBe("invalid_scopes");
  });

  it("429s when the per-workspace write budget is exhausted", async () => {
    const env = envWithDb(ADMIN_USER, ["acme"]) as Env & {
      WRITE_LIMITER: { limit: (opts: { key: string }) => Promise<{ success: boolean }> };
    };
    env.WRITE_LIMITER = { limit: async () => ({ success: false }) };
    const res = await app().request(
      "/admin-ui/workspaces/acme/invite-links",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      env,
    );
    expect(res.status).toBe(429);
  });
});

describe("GET /admin-ui/workspaces/:name/members", () => {
  it("proxies the internal member list", async () => {
    const env = stubEnv(ADMIN_USER, (path) => {
      if (path === "/internal/orgs/acme") {
        return Response.json({ organization: { id: "org1", slug: "acme", name: "acme" } });
      }
      if (path === "/internal/orgs/acme/members") {
        return Response.json({ members: [{ id: "m1", email: "x@y.com", role: "member" }] });
      }
      return new Response(null, { status: 404 });
    });
    const res = await app().request("/admin-ui/workspaces/acme/members", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ members: [{ id: "m1", email: "x@y.com", role: "member" }] });
  });
});

describe("GET /admin-ui/workspaces/:name/invites", () => {
  it("proxies the internal pending-invite list", async () => {
    const env = stubEnv(ADMIN_USER, (path) => {
      if (path === "/internal/orgs/acme") {
        return Response.json({ organization: { id: "org1", slug: "acme", name: "acme" } });
      }
      if (path === "/internal/orgs/acme/invites") {
        return Response.json({
          invites: [{ id: "inv1", email: "x@y.com", role: "member", status: "pending" }],
        });
      }
      return new Response(null, { status: 404 });
    });
    const res = await app().request("/admin-ui/workspaces/acme/invites", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      invites: [{ id: "inv1", email: "x@y.com", role: "member", status: "pending" }],
    });
  });

  it("404s when no org exists for the workspace", async () => {
    const env = stubEnv(ADMIN_USER, () => new Response(null, { status: 404 }));
    const res = await app().request("/admin-ui/workspaces/no-org/invites", {}, env);
    expect(res.status).toBe(404);
  });
});
