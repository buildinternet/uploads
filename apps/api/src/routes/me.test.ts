import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { respondError } from "../error-response";
import { me } from "./me";
import { UsageFakeD1 } from "../../test/usage-fake-d1";

const USER = { id: "u-plain", email: "plain@b.com", name: "Plain", role: "user" };

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
  user: typeof USER | null,
  onInternal: (path: string, req: Request) => Response | Promise<Response>,
  db: unknown = new UsageFakeD1(),
): Env {
  const auth = stubAuth((req) => {
    const url = new URL(req.url);
    if (url.pathname === "/api/auth/get-session") {
      return new Response(JSON.stringify(user ? { session: {}, user } : null), { status: 200 });
    }
    return onInternal(url.pathname, req);
  });
  return { AUTH: auth, DB: db, REGISTRY: fakeKv({}) } as unknown as Env;
}

function fakeKv(records: Record<string, unknown>): Pick<KVNamespace, "get"> {
  return {
    get: (async (key: string) =>
      key in records ? records[key] : null) as unknown as KVNamespace["get"],
  };
}

function app() {
  return new Hono<{ Bindings: Env }>().route("/me", me).onError((err, c) => respondError(c, err));
}

describe("/me auth gate", () => {
  it("401s with no session cookie", async () => {
    const env = stubEnv(null, () => new Response(null, { status: 404 }));
    const res = await app().request("/me/workspaces", {}, env);
    expect(res.status).toBe(401);
  });
});

describe("GET /me/workspaces", () => {
  it("maps memberships to workspaces via workspacesForOrg", async () => {
    const env = stubEnv(USER, (path) => {
      if (path === "/internal/memberships") {
        return Response.json([{ organizationId: "org1", organizationSlug: "acme", role: "owner" }]);
      }
      if (path === "/internal/orgs/acme") {
        return Response.json({ organization: { id: "org1", slug: "acme", name: "Acme Inc" } });
      }
      return new Response(null, { status: 404 });
    });
    const res = await app().request("/me/workspaces", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workspaces: [
        {
          workspace: "acme",
          organization: { id: "org1", slug: "acme", name: "Acme Inc" },
          role: "owner",
        },
      ],
    });
  });

  it("returns an empty list for a user with no memberships", async () => {
    const env = stubEnv(USER, (path) => {
      if (path === "/internal/memberships") return Response.json([]);
      return new Response(null, { status: 404 });
    });
    const res = await app().request("/me/workspaces", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspaces: [] });
  });
});

describe("GET /me/workspaces/:name/usage", () => {
  it("404s for a workspace the caller is not a member of", async () => {
    const env = stubEnv(USER, (path) => {
      if (path === "/internal/memberships") return Response.json([]);
      return new Response(null, { status: 404 });
    });
    const res = await app().request("/me/workspaces/acme/usage", {}, env);
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "workspace_not_found" },
    });
  });

  it("returns usage + limits for a workspace the caller is a member of", async () => {
    const db = new UsageFakeD1();
    db.usage.set("acme", {
      workspace: "acme",
      bytes: 500,
      objects: 3,
      uploads_in_period: 2,
      period_start: "2026-07",
      updated_at: "2026-07-10T00:00:00.000Z",
    });
    const env = stubEnv(
      USER,
      (path) => {
        if (path === "/internal/memberships") {
          return Response.json([
            { organizationId: "org1", organizationSlug: "acme", role: "member" },
          ]);
        }
        if (path === "/internal/orgs/acme") {
          return Response.json({ organization: { id: "org1", slug: "acme", name: "Acme Inc" } });
        }
        return new Response(null, { status: 404 });
      },
      db,
    );
    (env as unknown as { REGISTRY: Pick<KVNamespace, "get"> }).REGISTRY = fakeKv({
      "ws:acme": { provider: "r2", bucket: "acme-bucket", maxStorageBytes: 1000 },
    });

    const res = await app().request("/me/workspaces/acme/usage", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workspace: "acme",
      bytes: 500,
      objects: 3,
      uploadsInPeriod: 2,
      periodStart: "2026-07",
      updatedAt: "2026-07-10T00:00:00.000Z",
      maxStorageBytes: 1000,
      storageRemainingBytes: 500,
    });
  });
});
