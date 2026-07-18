import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { respondError } from "../error-response";
import { adminUi } from "./admin-ui";

const ADMIN_USER = { id: "u-admin", email: "admin@b.com", name: "Admin", role: "admin" };
const NON_ADMIN_USER = { id: "u-plain", email: "plain@b.com", name: "Plain", role: "user" };

const CANNED_CLIENT = {
  clientId: "c-1",
  name: "My App",
  type: "web",
  public: true,
  disabled: false,
  official: false,
  redirectUris: ["https://example.com/callback"],
  scopes: ["files:read"],
  uri: null,
  icon: null,
  userId: null,
  skipConsent: false,
  createdAt: 1737000000000,
  updatedAt: 1737000000000,
  consentCount: 0,
  activeTokenCount: 0,
  lastConsentAt: null,
};

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

describe("/admin-ui/oauth-clients auth gate", () => {
  it("401s with no session", async () => {
    const env = stubEnv(null, () => new Response("{}"));
    const res = await app().request("/admin-ui/oauth-clients", {}, env);
    expect(res.status).toBe(401);
  });

  it("403s for a non-admin session", async () => {
    const env = stubEnv(NON_ADMIN_USER, () => new Response("{}"));
    const res = await app().request("/admin-ui/oauth-clients", {}, env);
    expect(res.status).toBe(403);
  });
});

describe("GET /admin-ui/oauth-clients", () => {
  it("passes through the list from the internal endpoint", async () => {
    const env = stubEnv(ADMIN_USER, (path, req) => {
      if (path === "/internal/oauth-clients") {
        expect(req.headers.get("x-uploads-internal")).toBe("1");
        return Response.json({ clients: [CANNED_CLIENT] });
      }
      return new Response(null, { status: 404 });
    });
    const res = await app().request("/admin-ui/oauth-clients", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ clients: [CANNED_CLIENT] });
  });
});

describe("POST /admin-ui/oauth-clients", () => {
  it("passes through a create request body and 201 response", async () => {
    const env = stubEnv(ADMIN_USER, (path, req) => {
      if (path === "/internal/oauth-clients") {
        expect(req.headers.get("x-uploads-internal")).toBe("1");
        expect(req.headers.get("content-type")).toBe("application/json");
        return Response.json(CANNED_CLIENT, { status: 201 });
      }
      return new Response(null, { status: 404 });
    });
    const res = await app().request(
      "/admin-ui/oauth-clients",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "My App", redirectUris: ["https://example.com/callback"] }),
      },
      env,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(CANNED_CLIENT);
  });
});

describe("GET /admin-ui/oauth-clients/:clientId", () => {
  it("passes through a detail response", async () => {
    const env = stubEnv(ADMIN_USER, (path) => {
      if (path === "/internal/oauth-clients/c-1") return Response.json(CANNED_CLIENT);
      return new Response(null, { status: 404 });
    });
    const res = await app().request("/admin-ui/oauth-clients/c-1", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(CANNED_CLIENT);
  });

  it("passes through a 404", async () => {
    const env = stubEnv(ADMIN_USER, (path) => {
      if (path === "/internal/oauth-clients/missing") {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      return new Response(null, { status: 404 });
    });
    const res = await app().request("/admin-ui/oauth-clients/missing", {}, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

describe("PATCH /admin-ui/oauth-clients/:clientId", () => {
  it("passes through the patch body and response", async () => {
    const env = stubEnv(ADMIN_USER, (path, req) => {
      if (path === "/internal/oauth-clients/c-1") {
        expect(req.method).toBe("PATCH");
        expect(req.headers.get("x-uploads-internal")).toBe("1");
        return Response.json({ ...CANNED_CLIENT, disabled: true });
      }
      return new Response(null, { status: 404 });
    });
    const res = await app().request(
      "/admin-ui/oauth-clients/c-1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ disabled: true }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...CANNED_CLIENT, disabled: true });
  });
});

describe("DELETE /admin-ui/oauth-clients/:clientId", () => {
  it("passes through a delete response", async () => {
    const env = stubEnv(ADMIN_USER, (path, req) => {
      if (path === "/internal/oauth-clients/c-1") {
        expect(req.method).toBe("DELETE");
        return Response.json({ ok: true });
      }
      return new Response(null, { status: 404 });
    });
    const res = await app().request("/admin-ui/oauth-clients/c-1", { method: "DELETE" }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("relays a 409 from the internal endpoint when deleting an official client", async () => {
    const env = stubEnv(ADMIN_USER, (path, req) => {
      if (path === "/internal/oauth-clients/c-1") {
        expect(req.method).toBe("DELETE");
        return Response.json(
          {
            error: "official_client",
            message: "official clients cannot be deleted; remove the official flag first",
          },
          { status: 409 },
        );
      }
      return new Response(null, { status: 404 });
    });
    const res = await app().request("/admin-ui/oauth-clients/c-1", { method: "DELETE" }, env);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "official_client",
      message: "official clients cannot be deleted; remove the official flag first",
    });
  });
});

describe("AUTH binding outage", () => {
  it("503s when the AUTH binding throws", async () => {
    const auth: Pick<Fetcher, "fetch"> = {
      fetch: (async (input: RequestInfo | URL) => {
        const req = input instanceof Request ? input : new Request(input);
        const url = new URL(req.url);
        if (url.pathname === "/api/auth/get-session") {
          return new Response(JSON.stringify({ session: {}, user: ADMIN_USER }), { status: 200 });
        }
        throw new Error("binding unavailable");
      }) as Fetcher["fetch"],
    };
    const env = { AUTH: auth, REGISTRY: fakeKv([]) } as unknown as Env;
    const res = await app().request("/admin-ui/oauth-clients", {}, env);
    expect(res.status).toBe(503);
  });
});
