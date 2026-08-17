import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { respondError } from "./error-response";
import { workspaceAuth, type WorkspaceVars } from "./workspace";

const RECORD = {
  provider: "r2" as const,
  bucket: "shared",
  binding: "UPLOADS_DEFAULT",
  prefix: "acme/",
  publicBaseUrl: "https://storage.uploads.sh",
};

function stubAuth(handler: (req: Request) => Response | Promise<Response>): Pick<Fetcher, "fetch"> {
  return {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      return handler(req);
    }) as Fetcher["fetch"],
  };
}

function fakeRegistry(): Env["REGISTRY"] {
  const store = new Map<string, unknown>([["ws:acme", RECORD]]);
  return {
    get: (async (key: string) => store.get(key) ?? null) as unknown,
  } as Env["REGISTRY"];
}

function env(auth: Pick<Fetcher, "fetch">): Env {
  return { AUTH: auth, REGISTRY: fakeRegistry() } as unknown as Env;
}

function app() {
  return new Hono<WorkspaceVars>()
    .use("/v1/:workspace/*", workspaceAuth)
    .get("/v1/:workspace/whoami", (c) =>
      c.json({
        workspace: c.get("workspaceName"),
        scopes: c.get("authScopes"),
        source: c.get("authSource"),
        userId: c.get("mintingUserId"),
      }),
    )
    .onError((err, c) => respondError(c, err));
}

const KEY = "upl_sk_testdevkey";

describe("workspaceAuth API keys", () => {
  it("accepts a valid key for a workspace the user belongs to", async () => {
    const auth = stubAuth(async (req) => {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/internal/api-keys/verify") {
        return Response.json({
          valid: true,
          userId: "user-1",
          permissions: { files: ["read", "write"] },
          id: "key-1",
        });
      }
      if (url.pathname === "/internal/memberships") {
        return Response.json([
          { organizationId: "org-1", organizationSlug: "acme", role: "owner" },
        ]);
      }
      return new Response("nf", { status: 404 });
    });

    const res = await app().request(
      "/v1/acme/whoami",
      { headers: { Authorization: `Bearer ${KEY}` } },
      env(auth),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workspace: "acme",
      scopes: ["files:read", "files:write"],
      source: "api-key",
      userId: "user-1",
    });
  });

  it("401s an invalid key", async () => {
    const auth = stubAuth(async (req) => {
      if (new URL(req.url).pathname === "/internal/api-keys/verify") {
        return Response.json({ valid: false });
      }
      return new Response("nf", { status: 404 });
    });
    const res = await app().request(
      "/v1/acme/whoami",
      { headers: { Authorization: `Bearer ${KEY}` } },
      env(auth),
    );
    expect(res.status).toBe(401);
  });

  it("401s a valid key whose owner is not a member of the workspace", async () => {
    const auth = stubAuth(async (req) => {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/internal/api-keys/verify") {
        return Response.json({ valid: true, userId: "user-1", id: "key-1" });
      }
      if (url.pathname === "/internal/memberships") {
        return Response.json([]);
      }
      return new Response("nf", { status: 404 });
    });
    const res = await app().request(
      "/v1/acme/whoami",
      { headers: { Authorization: `Bearer ${KEY}` } },
      env(auth),
    );
    expect(res.status).toBe(401);
  });

  it("503s when the auth worker is down", async () => {
    const auth = stubAuth(async () => new Response(null, { status: 503 }));
    const res = await app().request(
      "/v1/acme/whoami",
      { headers: { Authorization: `Bearer ${KEY}` } },
      env(auth),
    );
    expect(res.status).toBe(503);
  });
});
