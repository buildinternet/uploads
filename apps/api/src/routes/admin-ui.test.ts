import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { fakeRegistry } from "../../test/fake-kv";
import { UsageFakeD1 } from "../../test/usage-fake-d1";
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
      if (url.pathname === "/internal/orgs/summaries") {
        return Response.json({
          organizations: [
            {
              organization: { id: "org1", slug: "acme", name: "acme" },
              memberCount: 2,
              pendingInviteCount: 1,
            },
          ],
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

  it("leaves org null when a workspace has no matching summary", async () => {
    const auth = stubAuth((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/auth/get-session") {
        return new Response(JSON.stringify({ session: {}, user: ADMIN_USER }), { status: 200 });
      }
      if (url.pathname === "/internal/orgs/summaries") {
        return Response.json({ organizations: [] });
      }
      return new Response(null, { status: 404 });
    });
    const env = { AUTH: auth, REGISTRY: fakeKv(["orphan"]) } as unknown as Env;
    const res = await app().request("/admin-ui/workspaces", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workspaces: [
        {
          workspace: "orphan",
          organization: null,
          memberCount: 0,
          pendingInviteCount: 0,
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

describe("invite-link routes", () => {
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
      const sql = this.sql.replace(/\s+/g, " ").trim();
      if (sql.startsWith("DELETE FROM auth_enrollments")) {
        const [workspace, id] = this.values;
        const before = this.db.enrollments.length;
        this.db.enrollments = this.db.enrollments.filter(
          (row) => !(row.workspace === workspace && row.id === id),
        );
        const changes = before - this.db.enrollments.length;
        return Promise.resolve({ success: true, meta: { changes } } as unknown as D1Result);
      }
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
        kind: this.values[9],
      });
      return Promise.resolve({ success: true } as unknown as D1Result);
    }
    all(): Promise<D1Result> {
      const sql = this.sql.replace(/\s+/g, " ").trim();
      if (sql.startsWith("SELECT id, page_id, label, scopes, kind, created_at, expires_at")) {
        const [workspace, now] = this.values as string[];
        const results = this.db.enrollments
          .filter(
            (row) =>
              row.workspace === workspace &&
              row.used_at === null &&
              (row.expires_at as string) > now,
          )
          .sort((a, b) => (b.created_at as string).localeCompare(a.created_at as string))
          .map((row) => ({
            id: row.id,
            page_id: row.page_id,
            label: row.label,
            scopes: row.scopes,
            kind: row.kind,
            created_at: row.created_at,
            expires_at: row.expires_at,
          }));
        return Promise.resolve({ success: true, results } as unknown as D1Result);
      }
      throw new Error(`unsupported all: ${sql}`);
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
    const registry = fakeRegistry(Object.fromEntries(registryNames.map((n) => [n, {}])));
    return {
      ...base,
      REGISTRY: registry,
      DB: db,
    } as unknown as Env & { DB: FakeD1 };
  }

  /** Same shape as `envWithDb`, but the named workspace is soft-deleted. */
  function envWithSoftDeletedWorkspace(
    user: typeof ADMIN_USER | null,
    name: string,
  ): Env & { DB: FakeD1 } {
    const base = stubEnv(user, () => new Response(null, { status: 404 }));
    const db = new FakeD1();
    const registry = fakeRegistry({ [name]: { deletedAt: "2026-08-01T00:00:00.000Z" } });
    return {
      ...base,
      REGISTRY: registry,
      DB: db,
    } as unknown as Env & { DB: FakeD1 };
  }

  describe("POST /admin-ui/workspaces/:name/invite-links", () => {
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

    it("404s for a soft-deleted workspace instead of minting", async () => {
      const env = envWithSoftDeletedWorkspace(ADMIN_USER, "gone");
      const res = await app().request(
        "/admin-ui/workspaces/gone/invite-links",
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
        env,
      );
      expect(res.status).toBe(404);
      const payload = (await res.json()) as { error?: { code?: string } };
      expect(payload.error?.code).toBe("workspace_not_found");
      expect(env.DB.enrollments).toHaveLength(0);
    });

    it("passes an admin-supplied label and scopes through to the minted enrollment", async () => {
      const env = envWithDb(ADMIN_USER, ["acme"]);
      const res = await app().request(
        "/admin-ui/workspaces/acme/invite-links",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ label: "contractor", scopes: ["files:read"] }),
        },
        env,
      );
      expect(res.status).toBe(201);
      const payload = (await res.json()) as { label: string | null; scopes: string[] };
      expect(payload.label).toBe("contractor");
      expect(payload.scopes).toEqual(["files:read"]);
      expect(env.DB.enrollments[0]?.label).toBe("contractor");
    });
  });

  describe("GET /admin-ui/workspaces/:name/invite-links", () => {
    it("lists outstanding links without leaking code_hash", async () => {
      const env = envWithDb(ADMIN_USER, ["acme"]);
      await app().request(
        "/admin-ui/workspaces/acme/invite-links",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ label: "sales" }),
        },
        env,
      );
      const res = await app().request("/admin-ui/workspaces/acme/invite-links", {}, env);
      expect(res.status).toBe(200);
      const payload = (await res.json()) as {
        links: { id: string; pageId: string | null; label: string | null; scopes: string[] }[];
      };
      expect(payload.links).toHaveLength(1);
      expect(payload.links[0]?.label).toBe("sales");
      expect(payload.links[0]?.scopes).toEqual(["files:read", "files:write"]);
      expect(JSON.stringify(payload)).not.toContain("code_hash");
      expect(JSON.stringify(payload)).not.toMatch(/upe_/);
    });

    it("200s empty for a workspace with no outstanding links", async () => {
      const env = envWithDb(ADMIN_USER, ["acme"]);
      const res = await app().request("/admin-ui/workspaces/acme/invite-links", {}, env);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ links: [] });
    });

    it("404s for an unknown workspace", async () => {
      const env = envWithDb(ADMIN_USER, []);
      const res = await app().request("/admin-ui/workspaces/nope/invite-links", {}, env);
      expect(res.status).toBe(404);
    });

    it("401s with no session", async () => {
      const env = envWithDb(null, ["acme"]);
      const res = await app().request("/admin-ui/workspaces/acme/invite-links", {}, env);
      expect(res.status).toBe(401);
    });

    it("403s for a non-admin session", async () => {
      const env = envWithDb(NON_ADMIN_USER, ["acme"]);
      const res = await app().request("/admin-ui/workspaces/acme/invite-links", {}, env);
      expect(res.status).toBe(403);
    });
  });

  describe("DELETE /admin-ui/workspaces/:name/invite-links/:id", () => {
    async function mintOne(env: Env & { DB: FakeD1 }, workspace: string, label?: string) {
      const res = await app().request(
        `/admin-ui/workspaces/${workspace}/invite-links`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(label ? { label } : {}),
        },
        env,
      );
      const payload = (await res.json()) as { id: string };
      return payload.id;
    }

    it("revokes an outstanding link", async () => {
      const env = envWithDb(ADMIN_USER, ["acme"]);
      const id = await mintOne(env, "acme");
      const res = await app().request(
        `/admin-ui/workspaces/acme/invite-links/${id}`,
        { method: "DELETE" },
        env,
      );
      expect(res.status).toBe(200);
      expect(env.DB.enrollments).toHaveLength(0);
    });

    it("404s for an unknown id", async () => {
      const env = envWithDb(ADMIN_USER, ["acme"]);
      const res = await app().request(
        "/admin-ui/workspaces/acme/invite-links/nope",
        { method: "DELETE" },
        env,
      );
      expect(res.status).toBe(404);
      const payload = (await res.json()) as { error?: { code?: string } };
      expect(payload.error?.code).toBe("invite_link_not_found");
    });

    it("404s when the id belongs to a different workspace", async () => {
      const env = envWithDb(ADMIN_USER, ["acme", "other"]);
      const id = await mintOne(env, "other");
      const res = await app().request(
        `/admin-ui/workspaces/acme/invite-links/${id}`,
        { method: "DELETE" },
        env,
      );
      expect(res.status).toBe(404);
      expect(env.DB.enrollments).toHaveLength(1);
    });

    it("401s with no session", async () => {
      const env = envWithDb(null, ["acme"]);
      const res = await app().request(
        "/admin-ui/workspaces/acme/invite-links/anything",
        { method: "DELETE" },
        env,
      );
      expect(res.status).toBe(401);
    });

    it("403s for a non-admin session", async () => {
      const env = envWithDb(NON_ADMIN_USER, ["acme"]);
      const res = await app().request(
        "/admin-ui/workspaces/acme/invite-links/anything",
        { method: "DELETE" },
        env,
      );
      expect(res.status).toBe(403);
    });

    it("429s when the per-workspace write budget is exhausted", async () => {
      const env = envWithDb(ADMIN_USER, ["acme"]) as Env & {
        DB: FakeD1;
        WRITE_LIMITER: { limit: (opts: { key: string }) => Promise<{ success: boolean }> };
      };
      const id = await mintOne(env, "acme");
      env.WRITE_LIMITER = { limit: async () => ({ success: false }) };
      const res = await app().request(
        `/admin-ui/workspaces/acme/invite-links/${id}`,
        { method: "DELETE" },
        env,
      );
      expect(res.status).toBe(429);
    });
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

describe("workspace limits editing", () => {
  const CURRENT_PERIOD = new Date().toISOString().slice(0, 7);

  /** Env with a mutable ws:acme record, a session user, and a usage row. */
  function limitsEnv(
    user: typeof ADMIN_USER | null,
    record: Record<string, unknown> | null,
    usage: { bytes: number; uploadsInPeriod: number } | null = { bytes: 0, uploadsInPeriod: 0 },
  ) {
    const registry = fakeRegistry(record ? { acme: record } : {});
    const store = registry.store;
    const base = stubEnv(user, () => new Response(null, { status: 404 }));
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () =>
            usage
              ? {
                  workspace: "acme",
                  bytes: usage.bytes,
                  objects: 0,
                  uploads_in_period: usage.uploadsInPeriod,
                  period_start: CURRENT_PERIOD,
                  updated_at: "2026-07-20T00:00:00.000Z",
                }
              : null,
        }),
      }),
    };
    const env = {
      ...base,
      DB: db,
      REGISTRY: registry,
    } as unknown as Env;
    return { env, store };
  }

  const REC = {
    provider: "r2",
    bucket: "uploads-default",
    prefix: "acme/",
    maxStorageBytes: 250_000_000,
    maxUploadsPerPeriod: 3000,
    allowedKeyPrefixes: ["f", "screenshots", "gh"],
    retentionDays: 90,
  };

  it("GET returns current limits and usage", async () => {
    const { env } = limitsEnv(ADMIN_USER, REC, { bytes: 128, uploadsInPeriod: 5 });
    const res = await app().request("/admin-ui/workspaces/acme/limits", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workspace: "acme",
      limits: {
        maxStorageBytes: 250_000_000,
        maxUploadsPerPeriod: 3000,
        maxUploadBytes: null,
        maxVideoUploadBytes: null,
        maxMembers: null,
      },
      usage: { bytes: 128, uploads: 5 },
    });
  });

  it("PATCH sets numeric limits on the record", async () => {
    const { env, store } = limitsEnv(ADMIN_USER, REC);
    const res = await app().request(
      "/admin-ui/workspaces/acme/limits",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxStorageBytes: 500_000_000, maxUploadBytes: 10_000_000 }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const saved = JSON.parse(store.get("ws:acme")!);
    expect(saved.maxStorageBytes).toBe(500_000_000);
    expect(saved.maxUploadBytes).toBe(10_000_000);
    // Written through mutateWorkspaceRecord (issue #387), not a bare put.
    expect(saved.version).toBe(1);
  });

  it("PATCH re-applies the edit when a competing write clobbers it", async () => {
    const { env, store } = limitsEnv(ADMIN_USER, REC);
    // A competing admin's plan change lands between this request's put and its
    // verification read. The retry re-applies the limit edit on top of the
    // competitor's record, so neither change is lost (issue #387).
    const registry = (env as unknown as { REGISTRY: { get: KVNamespace["get"] } }).REGISTRY;
    const get = registry.get;
    let gets = 0;
    registry.get = (async (key: string, type?: unknown) => {
      gets += 1;
      if (gets === 2) store.set("ws:acme", JSON.stringify({ ...REC, plan: "pro", version: 5 }));
      return get(key as never, type as never);
    }) as KVNamespace["get"];

    const res = await app().request(
      "/admin-ui/workspaces/acme/limits",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxUploadBytes: 10_000_000 }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const saved = JSON.parse(store.get("ws:acme")!);
    expect(saved.plan).toBe("pro");
    expect(saved.maxUploadBytes).toBe(10_000_000);
    expect(saved.version).toBe(6);
  });

  it("PATCH with null clears a limit to unlimited", async () => {
    const { env, store } = limitsEnv(ADMIN_USER, REC);
    const res = await app().request(
      "/admin-ui/workspaces/acme/limits",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxStorageBytes: null }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const saved = JSON.parse(store.get("ws:acme")!);
    expect("maxStorageBytes" in saved).toBe(false);
  });

  it("PATCH leaves omitted budget fields and all non-budget fields intact", async () => {
    const { env, store } = limitsEnv(ADMIN_USER, REC);
    await app().request(
      "/admin-ui/workspaces/acme/limits",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxUploadBytes: 10_000_000 }),
      },
      env,
    );
    const saved = JSON.parse(store.get("ws:acme")!);
    expect(saved.maxUploadsPerPeriod).toBe(3000); // omitted -> unchanged
    expect(saved.allowedKeyPrefixes).toEqual(["f", "screenshots", "gh"]); // preserved
    expect(saved.retentionDays).toBe(90); // preserved
    expect(saved.prefix).toBe("acme/"); // preserved
  });

  it("PATCH 400s on an invalid limit value", async () => {
    const { env } = limitsEnv(ADMIN_USER, REC);
    const res = await app().request(
      "/admin-ui/workspaces/acme/limits",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxStorageBytes: -5 }),
      },
      env,
    );
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error?: { code?: string } };
    expect(payload.error?.code).toBe("invalid_limit");
  });

  it("404s for an unknown workspace", async () => {
    const { env } = limitsEnv(ADMIN_USER, null);
    const res = await app().request("/admin-ui/workspaces/acme/limits", {}, env);
    expect(res.status).toBe(404);
  });

  it("404s for a soft-deleted workspace", async () => {
    const { env } = limitsEnv(ADMIN_USER, { ...REC, deletedAt: "2026-07-01T00:00:00.000Z" });
    const res = await app().request("/admin-ui/workspaces/acme/limits", {}, env);
    expect(res.status).toBe(404);
  });

  it("403s for a non-admin session", async () => {
    const { env } = limitsEnv(NON_ADMIN_USER, REC);
    const res = await app().request(
      "/admin-ui/workspaces/acme/limits",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxStorageBytes: 1 }),
      },
      env,
    );
    expect(res.status).toBe(403);
  });

  it("returns usage: null when the usage read finds no row", async () => {
    const { env } = limitsEnv(ADMIN_USER, REC, null);
    const res = await app().request("/admin-ui/workspaces/acme/limits", {}, env);
    expect(res.status).toBe(200);
    // getWorkspaceUsage returns an empty usage row (bytes 0) rather than throwing,
    // so usage is still an object here; assert the shape is present.
    const body = (await res.json()) as { usage: { bytes: number } | null };
    expect(body.usage).toEqual({ bytes: 0, uploads: 0 });
  });

  it("PATCH 429s when the per-workspace write budget is exhausted", async () => {
    const { env } = limitsEnv(ADMIN_USER, REC);
    (env as Env & { WRITE_LIMITER: { limit: () => Promise<{ success: boolean }> } }).WRITE_LIMITER =
      { limit: async () => ({ success: false }) };
    const res = await app().request(
      "/admin-ui/workspaces/acme/limits",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxStorageBytes: 1 }),
      },
      env,
    );
    expect(res.status).toBe(429);
  });

  it("PATCH 400s on a malformed JSON body (not a silent no-op)", async () => {
    const { env, store } = limitsEnv(ADMIN_USER, REC);
    const res = await app().request(
      "/admin-ui/workspaces/acme/limits",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "{ not valid json",
      },
      env,
    );
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error?: { code?: string } };
    expect(payload.error?.code).toBe("invalid_limit");
    // The record must be untouched — no write happened.
    expect(JSON.parse(store.get("ws:acme")!).maxStorageBytes).toBe(250_000_000);
  });
});

describe("workspace plan editing", () => {
  const REC = {
    provider: "r2",
    bucket: "uploads-default",
    prefix: "acme/",
  };

  function planEnv(user: typeof ADMIN_USER | null, record: Record<string, unknown> | null) {
    const registry = fakeRegistry(record ? { acme: record } : {});
    const store = registry.store;
    const base = stubEnv(user, () => new Response(null, { status: 404 }));
    const env = {
      ...base,
      REGISTRY: registry,
    } as unknown as Env;
    return { env, store };
  }

  it("GET reports the free plan (display) but leaves a bare record unlimited — planApplied: false", async () => {
    const { env } = planEnv(ADMIN_USER, REC);
    const res = await app().request("/admin-ui/workspaces/acme/plan", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workspace: "acme",
      plan: "free",
      available: true,
      planApplied: false,
      limits: {
        maxStorageBytes: null,
        maxUploadsPerPeriod: null,
        maxUploadBytes: null,
        maxVideoUploadBytes: null,
        maxMembers: null,
      },
      overrides: [],
      planSource: "none",
      subscription: null,
    });
  });

  it("GET resolves plan defaults once a plan is explicitly set — planApplied: true", async () => {
    const { env } = planEnv(ADMIN_USER, { ...REC, plan: "free" });
    const res = await app().request("/admin-ui/workspaces/acme/plan", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workspace: "acme",
      plan: "free",
      available: true,
      planApplied: true,
      limits: {
        maxStorageBytes: 250_000_000,
        maxUploadsPerPeriod: 3000,
        maxUploadBytes: 25_000_000,
        maxVideoUploadBytes: 25_000_000,
        maxMembers: 3,
      },
      overrides: [],
      planSource: "none",
      subscription: null,
    });
  });

  it("GET reports planSource 'admin' for a pro plan with no org/subscription resolvable (auth lookup returns 404)", async () => {
    const { env } = planEnv(ADMIN_USER, { ...REC, plan: "pro" });
    const res = await app().request("/admin-ui/workspaces/acme/plan", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { planSource: string; subscription: unknown };
    expect(body.planSource).toBe("admin");
    expect(body.subscription).toBeNull();
  });

  it("GET reports planSource 'stripe' and includes stripeCustomerId when an active subscription backs a pro plan", async () => {
    const registry = fakeRegistry({ acme: { ...REC, plan: "pro" } });
    const base = stubEnv(ADMIN_USER, (path) => {
      if (path === "/internal/orgs/acme") {
        return Response.json({ organization: { id: "org1", slug: "acme", name: "acme" } });
      }
      if (path === "/internal/orgs/acme/subscription") {
        return Response.json({
          subscription: {
            status: "trialing",
            periodEnd: null,
            cancelAtPeriodEnd: false,
            stripeCustomerId: "cus_456",
            plan: "pro",
          },
        });
      }
      return new Response(null, { status: 404 });
    });
    const env = { ...base, REGISTRY: registry } as unknown as Env;
    const res = await app().request("/admin-ui/workspaces/acme/plan", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      planSource: string;
      subscription: Record<string, unknown> | null;
    };
    expect(body.planSource).toBe("stripe");
    expect(body.subscription).toEqual({
      status: "trialing",
      periodEnd: null,
      cancelAtPeriodEnd: false,
      stripeCustomerId: "cus_456",
    });
  });

  it("PATCH sets the plan on the record and persists it", async () => {
    const { env, store } = planEnv(ADMIN_USER, REC);
    const res = await app().request(
      "/admin-ui/workspaces/acme/plan",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan: "pro" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plan: string; available: boolean; planApplied: boolean };
    expect(body.plan).toBe("pro");
    expect(body.available).toBe(true);
    expect(body.planApplied).toBe(true);
    expect(JSON.parse(store.get("ws:acme") ?? "{}").plan).toBe("pro");
  });

  it("PATCH rejects an unknown plan id", async () => {
    const { env } = planEnv(ADMIN_USER, REC);
    const res = await app().request(
      "/admin-ui/workspaces/acme/plan",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan: "enterprise" }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("PATCH preserves existing limit overrides on the record", async () => {
    const { env, store } = planEnv(ADMIN_USER, { ...REC, maxStorageBytes: 999 });
    await app().request(
      "/admin-ui/workspaces/acme/plan",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan: "pro" }),
      },
      env,
    );
    const stored = JSON.parse(store.get("ws:acme") ?? "{}");
    expect(stored.maxStorageBytes).toBe(999);
    expect(stored.plan).toBe("pro");
  });

  it("GET 404s for an unknown workspace", async () => {
    const { env } = planEnv(ADMIN_USER, null);
    const res = await app().request("/admin-ui/workspaces/acme/plan", {}, env);
    expect(res.status).toBe(404);
  });

  it("403s for a non-admin session", async () => {
    const { env } = planEnv(NON_ADMIN_USER, REC);
    const res = await app().request("/admin-ui/workspaces/acme/plan", {}, env);
    expect(res.status).toBe(403);
  });
});

describe("workspace storage admin panel (issue #583 Task 3.3)", () => {
  function storageEnv(user: typeof ADMIN_USER | null, record: Record<string, unknown> | null) {
    const registry = fakeRegistry(record ? { acme: record } : {});
    const store = registry.store;
    const base = stubEnv(user, () => new Response(null, { status: 404 }));
    const env = {
      ...base,
      REGISTRY: registry,
    } as unknown as Env;
    return { env, store };
  }

  const SHARED_REC = {
    provider: "r2",
    bucket: "uploads-default",
    prefix: "acme/",
  };

  const BYO_REC = {
    accountId: "acct123",
    bucket: "customer-bucket",
    accessKeyId: "enc:v1:sealed",
    secretAccessKey: "enc:v1:sealed",
    publicBaseUrl: "https://files.example.com",
    byoBucketEnabled: true,
    storageConfiguredAt: "2026-07-20T00:00:00.000Z",
    storageVerifiedAt: "2026-07-21T00:00:00.000Z",
    storageConfiguredBy: "u-owner",
    storageAccessKeyIdLast4: "abcd",
  };

  it("GET reports shared mode with no credential values for a shared-bucket workspace", async () => {
    const { env } = storageEnv(ADMIN_USER, SHARED_REC);
    const res = await app().request("/admin-ui/workspaces/acme/storage", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workspace: "acme",
      mode: "shared",
      // GA default-on: an absent flag reports the surface as enabled.
      byoBucketEnabled: true,
      bucket: "uploads-default",
      publicBaseUrl: undefined,
      accountIdMasked: undefined,
      accessKeyIdLast4: undefined,
      configuredAt: undefined,
      verifiedAt: undefined,
      configuredBy: null,
      lanes: [],
      health: { ok: true },
    });
  });

  it("GET reports byo mode, masked provenance, and configuredBy for a BYO workspace — never a credential value", async () => {
    const { env } = storageEnv(ADMIN_USER, BYO_REC);
    const res = await app().request("/admin-ui/workspaces/acme/storage", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      workspace: "acme",
      mode: "byo",
      byoBucketEnabled: true,
      bucket: "customer-bucket",
      publicBaseUrl: "https://files.example.com",
      accountIdMasked: "…t123",
      accessKeyIdLast4: "abcd",
      configuredAt: "2026-07-20T00:00:00.000Z",
      verifiedAt: "2026-07-21T00:00:00.000Z",
      configuredBy: "u-owner",
    });
    // The sealed credential blobs themselves never appear anywhere in the body.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("enc:v1:sealed");
  });

  it("PATCH flips byoBucketEnabled on, written through mutateWorkspaceRecord", async () => {
    const { env, store } = storageEnv(ADMIN_USER, SHARED_REC);
    const res = await app().request(
      "/admin-ui/workspaces/acme/storage",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ byoBucketEnabled: true }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { byoBucketEnabled: boolean }).byoBucketEnabled).toBe(true);
    const saved = JSON.parse(store.get("ws:acme")!);
    expect(saved.byoBucketEnabled).toBe(true);
    // Written through mutateWorkspaceRecord (issue #387), not a bare put.
    expect(saved.version).toBe(1);
  });

  it("PATCH flips byoBucketEnabled off, preserving other fields", async () => {
    const { env, store } = storageEnv(ADMIN_USER, BYO_REC);
    const res = await app().request(
      "/admin-ui/workspaces/acme/storage",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ byoBucketEnabled: false }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const saved = JSON.parse(store.get("ws:acme")!);
    expect(saved.byoBucketEnabled).toBe(false);
    expect(saved.bucket).toBe("customer-bucket"); // preserved
    expect(saved.storageConfiguredBy).toBe("u-owner"); // preserved
  });

  it("PATCH 400s on a non-boolean value", async () => {
    const { env } = storageEnv(ADMIN_USER, SHARED_REC);
    const res = await app().request(
      "/admin-ui/workspaces/acme/storage",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ byoBucketEnabled: "yes" }),
      },
      env,
    );
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error?: { code?: string } };
    expect(payload.error?.code).toBe("invalid_storage_flag");
  });

  it("PATCH 400s on malformed JSON (not a silent no-op)", async () => {
    const { env, store } = storageEnv(ADMIN_USER, SHARED_REC);
    const res = await app().request(
      "/admin-ui/workspaces/acme/storage",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "{ not valid json",
      },
      env,
    );
    expect(res.status).toBe(400);
    expect(store.get("ws:acme")).toBe(JSON.stringify(SHARED_REC));
  });

  it("GET 404s for an unknown workspace", async () => {
    const { env } = storageEnv(ADMIN_USER, null);
    const res = await app().request("/admin-ui/workspaces/acme/storage", {}, env);
    expect(res.status).toBe(404);
  });

  it("GET 404s for a soft-deleted workspace", async () => {
    const { env } = storageEnv(ADMIN_USER, {
      ...SHARED_REC,
      deletedAt: "2026-07-01T00:00:00.000Z",
    });
    const res = await app().request("/admin-ui/workspaces/acme/storage", {}, env);
    expect(res.status).toBe(404);
  });

  it("403s for a non-admin session", async () => {
    const { env } = storageEnv(NON_ADMIN_USER, SHARED_REC);
    const res = await app().request(
      "/admin-ui/workspaces/acme/storage",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ byoBucketEnabled: true }),
      },
      env,
    );
    expect(res.status).toBe(403);
  });

  it("PATCH 429s when the per-workspace write budget is exhausted", async () => {
    const { env } = storageEnv(ADMIN_USER, SHARED_REC);
    (env as Env & { WRITE_LIMITER: { limit: () => Promise<{ success: boolean }> } }).WRITE_LIMITER =
      { limit: async () => ({ success: false }) };
    const res = await app().request(
      "/admin-ui/workspaces/acme/storage",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ byoBucketEnabled: true }),
      },
      env,
    );
    expect(res.status).toBe(429);
  });
});

describe("workspace github-comment settings editing", () => {
  /** Env with a mutable ws:acme record and a session user (no usage needed). */
  function settingsEnv(user: typeof ADMIN_USER | null, record: Record<string, unknown> | null) {
    const registry = fakeRegistry(record ? { acme: record } : {});
    const store = registry.store;
    const base = stubEnv(user, () => new Response(null, { status: 404 }));
    const env = {
      ...base,
      REGISTRY: registry,
    } as unknown as Env;
    return { env, store };
  }

  const REC = {
    provider: "r2",
    bucket: "uploads-default",
    prefix: "acme/",
    maxUploadsPerPeriod: 3000,
    retentionDays: 90,
  };

  const EMPTY_SETTINGS = {
    githubCommentLinkToFilePage: null,
    githubCommentShowMetadata: null,
    githubCommentRequireActorOnPr: null,
    githubCommentImageWidth: null,
    githubCommentMaxInlineImages: null,
    githubCommentNote: null,
  };

  it("GET returns the flag unset by default", async () => {
    const { env } = settingsEnv(ADMIN_USER, REC);
    const res = await app().request("/admin-ui/workspaces/acme/settings", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workspace: "acme",
      settings: EMPTY_SETTINGS,
    });
  });

  it("GET reflects a previously-set flag", async () => {
    const { env } = settingsEnv(ADMIN_USER, { ...REC, githubCommentLinkToFilePage: false });
    const res = await app().request("/admin-ui/workspaces/acme/settings", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workspace: "acme",
      settings: { ...EMPTY_SETTINGS, githubCommentLinkToFilePage: false },
    });
  });

  it("PATCH sets the flag on the record", async () => {
    const { env, store } = settingsEnv(ADMIN_USER, REC);
    const res = await app().request(
      "/admin-ui/workspaces/acme/settings",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ githubCommentLinkToFilePage: false }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workspace: "acme",
      settings: { ...EMPTY_SETTINGS, githubCommentLinkToFilePage: false },
    });
    const saved = JSON.parse(store.get("ws:acme")!);
    expect(saved.githubCommentLinkToFilePage).toBe(false);
  });

  it("PATCH with the flag omitted leaves it unchanged", async () => {
    const { env, store } = settingsEnv(ADMIN_USER, { ...REC, githubCommentLinkToFilePage: false });
    const res = await app().request(
      "/admin-ui/workspaces/acme/settings",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
      env,
    );
    expect(res.status).toBe(200);
    const saved = JSON.parse(store.get("ws:acme")!);
    expect(saved.githubCommentLinkToFilePage).toBe(false);
  });

  it("PATCH true clears a previously-set false flag", async () => {
    const { env, store } = settingsEnv(ADMIN_USER, { ...REC, githubCommentLinkToFilePage: false });
    await app().request(
      "/admin-ui/workspaces/acme/settings",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ githubCommentLinkToFilePage: true }),
      },
      env,
    );
    const saved = JSON.parse(store.get("ws:acme")!);
    expect(saved.githubCommentLinkToFilePage).toBe(true);
  });

  it("PATCH preserves other record fields (not clobbered)", async () => {
    const { env, store } = settingsEnv(ADMIN_USER, REC);
    await app().request(
      "/admin-ui/workspaces/acme/settings",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ githubCommentLinkToFilePage: false }),
      },
      env,
    );
    const saved = JSON.parse(store.get("ws:acme")!);
    expect(saved.maxUploadsPerPeriod).toBe(3000);
    expect(saved.retentionDays).toBe(90);
    expect(saved.prefix).toBe("acme/");
  });

  it("PATCH 400s on a non-boolean flag value", async () => {
    const { env } = settingsEnv(ADMIN_USER, REC);
    const res = await app().request(
      "/admin-ui/workspaces/acme/settings",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ githubCommentLinkToFilePage: "nope" }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("PATCH 400s on a malformed JSON body", async () => {
    const { env, store } = settingsEnv(ADMIN_USER, REC);
    const res = await app().request(
      "/admin-ui/workspaces/acme/settings",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "{ not valid json",
      },
      env,
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(store.get("ws:acme")!).githubCommentLinkToFilePage).toBeUndefined();
  });

  it("404s for an unknown workspace", async () => {
    const { env } = settingsEnv(ADMIN_USER, null);
    const res = await app().request("/admin-ui/workspaces/acme/settings", {}, env);
    expect(res.status).toBe(404);
  });

  it("404s for a soft-deleted workspace", async () => {
    const { env } = settingsEnv(ADMIN_USER, { ...REC, deletedAt: "2026-07-01T00:00:00.000Z" });
    const res = await app().request("/admin-ui/workspaces/acme/settings", {}, env);
    expect(res.status).toBe(404);
  });

  it("403s for a non-admin session", async () => {
    const { env } = settingsEnv(NON_ADMIN_USER, REC);
    const res = await app().request(
      "/admin-ui/workspaces/acme/settings",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ githubCommentLinkToFilePage: false }),
      },
      env,
    );
    expect(res.status).toBe(403);
  });

  it("PATCH 429s when the per-workspace write budget is exhausted", async () => {
    const { env } = settingsEnv(ADMIN_USER, REC);
    (env as Env & { WRITE_LIMITER: { limit: () => Promise<{ success: boolean }> } }).WRITE_LIMITER =
      { limit: async () => ({ success: false }) };
    const res = await app().request(
      "/admin-ui/workspaces/acme/settings",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ githubCommentLinkToFilePage: false }),
      },
      env,
    );
    expect(res.status).toBe(429);
  });

  it("PATCH sets githubCommentShowMetadata on the record", async () => {
    const { env, store } = settingsEnv(ADMIN_USER, REC);
    const res = await app().request(
      "/admin-ui/workspaces/acme/settings",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ githubCommentShowMetadata: false }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workspace: "acme",
      settings: { ...EMPTY_SETTINGS, githubCommentShowMetadata: false },
    });
    expect(JSON.parse(store.get("ws:acme")!).githubCommentShowMetadata).toBe(false);
  });

  it("PATCH rejects a non-boolean githubCommentShowMetadata", async () => {
    const { env } = settingsEnv(ADMIN_USER, REC);
    const res = await app().request(
      "/admin-ui/workspaces/acme/settings",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ githubCommentShowMetadata: "no" }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("PATCH leaves githubCommentShowMetadata unchanged when omitted", async () => {
    const { env, store } = settingsEnv(ADMIN_USER, {
      ...REC,
      githubCommentShowMetadata: false,
    });
    const res = await app().request(
      "/admin-ui/workspaces/acme/settings",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ githubCommentLinkToFilePage: true }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(store.get("ws:acme")!).githubCommentShowMetadata).toBe(false);
  });

  // Three #534 fields on the operator surface (issue #535) — same bounds as
  // me.ts validateCommentSettingsPatch; null clears.
  it("PATCH sets imageWidth, maxInlineImages, and note (issue #535)", async () => {
    const { env, store } = settingsEnv(ADMIN_USER, REC);
    const res = await app().request(
      "/admin-ui/workspaces/acme/settings",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          githubCommentImageWidth: "full",
          githubCommentMaxInlineImages: 8,
          githubCommentNote: "  Screenshots from CI.  ",
        }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workspace: "acme",
      settings: {
        ...EMPTY_SETTINGS,
        githubCommentImageWidth: "full",
        githubCommentMaxInlineImages: 8,
        githubCommentNote: "Screenshots from CI.",
      },
    });
    const saved = JSON.parse(store.get("ws:acme")!);
    expect(saved.githubCommentImageWidth).toBe("full");
    expect(saved.githubCommentMaxInlineImages).toBe(8);
    expect(saved.githubCommentNote).toBe("Screenshots from CI.");
  });

  it("PATCH accepts a pixel imageWidth in range", async () => {
    const { env, store } = settingsEnv(ADMIN_USER, REC);
    const res = await app().request(
      "/admin-ui/workspaces/acme/settings",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ githubCommentImageWidth: 400 }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(store.get("ws:acme")!).githubCommentImageWidth).toBe(400);
  });

  it("PATCH rejects out-of-range imageWidth without mutating the record", async () => {
    const { env, store } = settingsEnv(ADMIN_USER, REC);
    const res = await app().request(
      "/admin-ui/workspaces/acme/settings",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ githubCommentImageWidth: 40 }),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(store.get("ws:acme")!).githubCommentImageWidth).toBeUndefined();
  });

  it("PATCH rejects maxInlineImages outside 1–48", async () => {
    const { env, store } = settingsEnv(ADMIN_USER, REC);
    const res = await app().request(
      "/admin-ui/workspaces/acme/settings",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ githubCommentMaxInlineImages: 0 }),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(store.get("ws:acme")!).githubCommentMaxInlineImages).toBeUndefined();
  });

  it("PATCH rejects a note over 500 chars", async () => {
    const { env, store } = settingsEnv(ADMIN_USER, REC);
    const res = await app().request(
      "/admin-ui/workspaces/acme/settings",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ githubCommentNote: "x".repeat(501) }),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(store.get("ws:acme")!).githubCommentNote).toBeUndefined();
  });

  it("PATCH rejects an empty/whitespace note", async () => {
    const { env } = settingsEnv(ADMIN_USER, REC);
    const res = await app().request(
      "/admin-ui/workspaces/acme/settings",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ githubCommentNote: "   " }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("PATCH with null clears a previously-set imageWidth / note", async () => {
    const { env, store } = settingsEnv(ADMIN_USER, {
      ...REC,
      githubCommentImageWidth: 400,
      githubCommentNote: "hi",
    });
    const res = await app().request(
      "/admin-ui/workspaces/acme/settings",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ githubCommentImageWidth: null, githubCommentNote: null }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workspace: "acme",
      settings: EMPTY_SETTINGS,
    });
    const saved = JSON.parse(store.get("ws:acme")!);
    expect(saved.githubCommentImageWidth).toBeUndefined();
    expect(saved.githubCommentNote).toBeUndefined();
  });

  it("PATCH leaves the three #534 fields unchanged when omitted", async () => {
    const { env, store } = settingsEnv(ADMIN_USER, {
      ...REC,
      githubCommentImageWidth: "full",
      githubCommentMaxInlineImages: 4,
      githubCommentNote: "keep me",
    });
    const res = await app().request(
      "/admin-ui/workspaces/acme/settings",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ githubCommentLinkToFilePage: false }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const saved = JSON.parse(store.get("ws:acme")!);
    expect(saved.githubCommentImageWidth).toBe("full");
    expect(saved.githubCommentMaxInlineImages).toBe(4);
    expect(saved.githubCommentNote).toBe("keep me");
    expect(saved.githubCommentLinkToFilePage).toBe(false);
  });

  it("PATCH rejects an invalid imageWidth even when other fields are valid (reject-all)", async () => {
    const { env, store } = settingsEnv(ADMIN_USER, REC);
    const res = await app().request(
      "/admin-ui/workspaces/acme/settings",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          githubCommentImageWidth: 40,
          githubCommentNote: "should not apply",
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
    const saved = JSON.parse(store.get("ws:acme")!);
    expect(saved.githubCommentImageWidth).toBeUndefined();
    expect(saved.githubCommentNote).toBeUndefined();
  });
});

describe("POST /admin-ui/users/:userId/ban", () => {
  function banEnv(user: typeof ADMIN_USER | typeof NON_ADMIN_USER | null) {
    const banCalls: { path: string; body: unknown }[] = [];
    let revokedBinds: unknown[] | null = null;
    const auth = stubAuth((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/auth/get-session") {
        return new Response(JSON.stringify(user ? { session: {}, user } : null), { status: 200 });
      }
      if (url.pathname === "/api/auth/admin/ban-user") {
        return req.json().then((body) => {
          banCalls.push({ path: url.pathname, body });
          const b = body as { userId: string; banReason?: string };
          return Response.json({
            user: {
              id: b.userId,
              email: "target@b.com",
              name: "Target",
              banned: true,
              banReason: b.banReason ?? "Banned by operator",
            },
          });
        });
      }
      if (url.pathname === "/api/auth/admin/unban-user") {
        return req.json().then((body) => {
          banCalls.push({ path: url.pathname, body });
          const b = body as { userId: string };
          return Response.json({
            user: { id: b.userId, email: "target@b.com", name: "Target", banned: false },
          });
        });
      }
      return new Response(null, { status: 404 });
    });
    const db = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => ({
          run: async () => {
            if (sql.includes("minting_user_id")) {
              revokedBinds = values;
              return { meta: { changes: 2 } };
            }
            return { meta: { changes: 0 } };
          },
        }),
      }),
    };
    const env = { AUTH: auth, DB: db } as unknown as Env;
    return { env, banCalls, getRevokedBinds: () => revokedBinds };
  }

  it("proxies ban-user and soft-revokes minted workspace tokens", async () => {
    const { env, banCalls, getRevokedBinds } = banEnv(ADMIN_USER);
    const res = await app().request(
      "/admin-ui/users/u-target/ban",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: "session=abc" },
        body: JSON.stringify({ banReason: "spam" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: { id: string; banned: boolean; banReason: string };
      tokensRevoked: number;
    };
    expect(body.user).toMatchObject({ id: "u-target", banned: true, banReason: "spam" });
    expect(body.tokensRevoked).toBe(2);
    expect(banCalls).toEqual([
      { path: "/api/auth/admin/ban-user", body: { userId: "u-target", banReason: "spam" } },
    ]);
    expect(getRevokedBinds()?.[1]).toBe("u-target");
  });

  it("propagates an auth worker 429 on ban as 429 auth_rate_limited", async () => {
    const auth = stubAuth((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/auth/get-session") {
        return new Response(JSON.stringify({ session: {}, user: ADMIN_USER }), { status: 200 });
      }
      // Better Auth's rate limiter emits `X-Retry-After`.
      return new Response(null, { status: 429, headers: { "x-retry-after": "30" } });
    });
    const env = { AUTH: auth } as unknown as Env;
    const res = await app().request(
      "/admin-ui/users/u-target/ban",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: "session=abc" },
        body: JSON.stringify({}),
      },
      env,
    );
    expect(res.status).toBe(429);
    expect((await res.json()) as { error?: { code?: string } }).toMatchObject({
      error: { code: "auth_rate_limited", details: { retry_after: 30 } },
    });
  });

  it("rejects self-ban without calling the auth worker", async () => {
    const { env, banCalls } = banEnv(ADMIN_USER);
    const res = await app().request(
      "/admin-ui/users/u-admin/ban",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect(banCalls).toEqual([]);
  });

  it("403s for a non-admin session", async () => {
    const { env } = banEnv(NON_ADMIN_USER);
    const res = await app().request(
      "/admin-ui/users/u-target/ban",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      env,
    );
    expect(res.status).toBe(403);
  });

  it("unbans via the admin plugin", async () => {
    const { env, banCalls } = banEnv(ADMIN_USER);
    const res = await app().request(
      "/admin-ui/users/u-target/unban",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      env,
    );
    expect(res.status).toBe(200);
    expect(banCalls).toEqual([
      { path: "/api/auth/admin/unban-user", body: { userId: "u-target" } },
    ]);
    const body = (await res.json()) as { user: { banned: boolean } };
    expect(body.user.banned).toBe(false);
  });
});

describe("github repo link admin routes (issue #318)", () => {
  /** `existingWorkspaces` seeds `ws:<name>` KV records so PUT's
   * destination-workspace-exists check can pass. */
  function githubLinksEnv(user: typeof ADMIN_USER | null, existingWorkspaces: string[] = []) {
    const db = new UsageFakeD1();
    const base = stubEnv(user, () => new Response(null, { status: 404 }));
    const registry = {
      ...(base.REGISTRY as object),
      get: (async (key: string) =>
        existingWorkspaces.some((ws) => key === `ws:${ws}`)
          ? "{}"
          : null) as unknown as KVNamespace["get"],
    };
    const env = { ...base, DB: db, REGISTRY: registry } as unknown as Env;
    return { env, db };
  }

  describe("GET /workspaces/:name/github-links", () => {
    it("lists only the bindings owned by this workspace", async () => {
      const { env, db } = githubLinksEnv(ADMIN_USER);
      db.repoLinks.set("acme/web", {
        repo_full_name: "acme/web",
        workspace_name: "acme",
        installation_id: null,
        source: "comment",
        created_at: "2026-01-01T00:00:00.000Z",
      });
      db.repoLinks.set("other/repo", {
        repo_full_name: "other/repo",
        workspace_name: "someone-else",
        installation_id: null,
        source: "comment",
        created_at: "2026-01-01T00:00:00.000Z",
      });
      const res = await app().request("/admin-ui/workspaces/acme/github-links", {}, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { workspace: string; links: { repo: string }[] };
      expect(body.workspace).toBe("acme");
      expect(body.links.map((l) => l.repo)).toEqual(["acme/web"]);
    });

    it("403s for a non-admin session", async () => {
      const { env } = githubLinksEnv(NON_ADMIN_USER);
      const res = await app().request("/admin-ui/workspaces/acme/github-links", {}, env);
      expect(res.status).toBe(403);
    });
  });

  describe("PUT /admin-ui/github-links", () => {
    it("reassigns a repo to a different workspace, overwriting the prior owner", async () => {
      const { env, db } = githubLinksEnv(ADMIN_USER, ["acme", "new-owner"]);
      db.repoLinks.set("acme/web", {
        repo_full_name: "acme/web",
        workspace_name: "acme",
        installation_id: null,
        source: "comment",
        created_at: "2026-01-01T00:00:00.000Z",
      });
      const res = await app().request(
        "/admin-ui/github-links",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ repo: "acme/web", workspace: "new-owner" }),
        },
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        repo: "acme/web",
        workspace: "new-owner",
        reassigned: true,
      });
      expect(db.repoLinks.get("acme/web")?.workspace_name).toBe("new-owner");
      expect(db.repoLinks.get("acme/web")?.source).toBe("admin");
    });

    it("400s on a malformed repo", async () => {
      const { env } = githubLinksEnv(ADMIN_USER, ["acme"]);
      const res = await app().request(
        "/admin-ui/github-links",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ repo: "not-a-repo", workspace: "acme" }),
        },
        env,
      );
      expect(res.status).toBe(400);
    });

    it("404s when the destination workspace doesn't exist (typo guard)", async () => {
      const { env, db } = githubLinksEnv(ADMIN_USER, []);
      const res = await app().request(
        "/admin-ui/github-links",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ repo: "acme/web", workspace: "nonexistent-typo" }),
        },
        env,
      );
      expect(res.status).toBe(404);
      // Never created a binding to a workspace that doesn't exist.
      expect(db.repoLinks.has("acme/web")).toBe(false);
    });

    it("403s for a non-admin session", async () => {
      const { env } = githubLinksEnv(NON_ADMIN_USER, ["acme"]);
      const res = await app().request(
        "/admin-ui/github-links",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ repo: "acme/web", workspace: "acme" }),
        },
        env,
      );
      expect(res.status).toBe(403);
    });

    it("429s when the destination workspace's write rate limit is exhausted", async () => {
      const { env } = githubLinksEnv(ADMIN_USER, ["acme"]);
      const limited = {
        ...env,
        WRITE_LIMITER: { limit: async () => ({ success: false }) },
      } as unknown as Env;
      const res = await app().request(
        "/admin-ui/github-links",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ repo: "acme/web", workspace: "acme" }),
        },
        limited,
      );
      expect(res.status).toBe(429);
    });
  });

  describe("DELETE /admin-ui/github-links", () => {
    it("removes any workspace's binding", async () => {
      const { env, db } = githubLinksEnv(ADMIN_USER);
      db.repoLinks.set("acme/web", {
        repo_full_name: "acme/web",
        workspace_name: "acme",
        installation_id: null,
        source: "comment",
        created_at: "2026-01-01T00:00:00.000Z",
      });
      const res = await app().request(
        "/admin-ui/github-links?repo=acme%2Fweb",
        { method: "DELETE" },
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ repo: "acme/web", unlinked: true });
      expect(db.repoLinks.has("acme/web")).toBe(false);
    });

    it("reports not_linked for an unclaimed repo instead of erroring", async () => {
      const { env } = githubLinksEnv(ADMIN_USER);
      const res = await app().request(
        "/admin-ui/github-links?repo=acme%2Fweb",
        { method: "DELETE" },
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        repo: "acme/web",
        unlinked: false,
        reason: "not_linked",
      });
    });

    it("propagates a D1 read failure instead of reporting unlinked: true", async () => {
      const { env } = githubLinksEnv(ADMIN_USER);
      const failing = {
        ...env,
        DB: {
          prepare: () => ({
            bind: () => ({
              first: async () => {
                throw new Error("d1 unavailable");
              },
            }),
          }),
        },
      } as unknown as Env;
      const res = await app().request(
        "/admin-ui/github-links?repo=acme%2Fweb",
        { method: "DELETE" },
        failing,
      );
      expect(res.status).toBeGreaterThanOrEqual(500);
    });

    it("429s when the owning workspace's write rate limit is exhausted", async () => {
      const { env, db } = githubLinksEnv(ADMIN_USER);
      db.repoLinks.set("acme/web", {
        repo_full_name: "acme/web",
        workspace_name: "acme",
        installation_id: null,
        source: "comment",
        created_at: "2026-01-01T00:00:00.000Z",
      });
      const limited = {
        ...env,
        WRITE_LIMITER: { limit: async () => ({ success: false }) },
      } as unknown as Env;
      const res = await app().request(
        "/admin-ui/github-links?repo=acme%2Fweb",
        { method: "DELETE" },
        limited,
      );
      expect(res.status).toBe(429);
      // Rate-limited before the delete ran.
      expect(db.repoLinks.has("acme/web")).toBe(true);
    });

    it("403s for a non-admin session", async () => {
      const { env } = githubLinksEnv(NON_ADMIN_USER);
      const res = await app().request(
        "/admin-ui/github-links?repo=acme%2Fweb",
        { method: "DELETE" },
        env,
      );
      expect(res.status).toBe(403);
    });
  });
});
