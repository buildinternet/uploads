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
