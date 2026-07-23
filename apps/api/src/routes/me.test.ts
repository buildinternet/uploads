import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { respondError } from "../error-response";
import { me } from "./me";
import { UsageFakeD1 } from "../../test/usage-fake-d1";
import { FakeR2Bucket } from "../../test/fake-r2";

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
  it("maps memberships to workspaces without per-org AUTH round-trips", async () => {
    const env = stubEnv(USER, (path) => {
      if (path === "/internal/memberships") {
        return Response.json([
          {
            organizationId: "org1",
            organizationSlug: "acme",
            organizationName: "Acme Inc",
            role: "owner",
          },
        ]);
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
          hasPublicUrl: false,
          plan: "free",
        },
      ],
    });
  });

  it("flags hasPublicUrl for a workspace whose storage record has a publicBaseUrl", async () => {
    const env = stubEnv(USER, (path) => {
      if (path === "/internal/memberships") {
        return Response.json([
          {
            organizationId: "org1",
            organizationSlug: "acme",
            organizationName: "Acme Inc",
            role: "owner",
          },
        ]);
      }
      return new Response(null, { status: 404 });
    });
    (env as unknown as { REGISTRY: Pick<KVNamespace, "get"> }).REGISTRY = fakeKv({
      "ws:acme": {
        provider: "r2",
        bucket: "shared",
        publicBaseUrl: "https://storage.uploads.sh",
      },
    });
    const res = await app().request("/me/workspaces", {}, env);
    const body = (await res.json()) as {
      workspaces: { workspace: string; hasPublicUrl: boolean }[];
    };
    expect(body.workspaces).toEqual([
      expect.objectContaining({
        workspace: "acme",
        hasPublicUrl: true,
        publicBaseUrl: "https://storage.uploads.sh",
      }),
    ]);
  });

  it("treats a workspace named 'default' as an ordinary workspace", async () => {
    const env = stubEnv(USER, (path) => {
      if (path === "/internal/memberships") {
        return Response.json([
          {
            organizationId: "org2",
            organizationSlug: "default",
            organizationName: "Default",
            role: "member",
          },
        ]);
      }
      return new Response(null, { status: 404 });
    });
    // No REGISTRY record for "default" — same as any workspace with no
    // publicBaseUrl configured; the lookup just resolves to undefined rather
    // than being skipped by a name-based short-circuit.
    const res = await app().request("/me/workspaces", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workspaces: [
        {
          workspace: "default",
          organization: { id: "org2", slug: "default", name: "Default" },
          role: "member",
          hasPublicUrl: false,
          plan: "free",
        },
      ],
    });
  });

  it("503s when the memberships lookup fails (AUTH outage is not zero memberships)", async () => {
    const env = stubEnv(USER, () => new Response(null, { status: 500 }));
    const res = await app().request("/me/workspaces", {}, env);
    expect(res.status).toBe(503);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "auth_lookup_failed" },
    });
  });

  it("reports plan: 'pro' for a workspace record explicitly on the pro plan (issue #365 follow-up)", async () => {
    const env = stubEnv(USER, (path) => {
      if (path === "/internal/memberships") {
        return Response.json([
          {
            organizationId: "org1",
            organizationSlug: "acme",
            organizationName: "Acme Inc",
            role: "owner",
          },
        ]);
      }
      return new Response(null, { status: 404 });
    });
    (env as unknown as { REGISTRY: Pick<KVNamespace, "get"> }).REGISTRY = fakeKv({
      "ws:acme": { provider: "r2", bucket: "shared", plan: "pro" },
    });
    const res = await app().request("/me/workspaces", {}, env);
    const body = (await res.json()) as { workspaces: { workspace: string; plan: string }[] };
    expect(body.workspaces).toEqual([expect.objectContaining({ workspace: "acme", plan: "pro" })]);
  });

  it("never reports plan: 'pro' for a legacy record with no plan field applied, even with pro-shaped overrides", async () => {
    const env = stubEnv(USER, (path) => {
      if (path === "/internal/memberships") {
        return Response.json([
          {
            organizationId: "org1",
            organizationSlug: "acme",
            organizationName: "Acme Inc",
            role: "owner",
          },
        ]);
      }
      return new Response(null, { status: 404 });
    });
    // No `plan` field at all — planApplied is false; `plan` must still fail
    // open to "free" (getPlan's contract), never leak as "pro".
    (env as unknown as { REGISTRY: Pick<KVNamespace, "get"> }).REGISTRY = fakeKv({
      "ws:acme": { provider: "r2", bucket: "shared", maxStorageBytes: null },
    });
    const res = await app().request("/me/workspaces", {}, env);
    const body = (await res.json()) as { workspaces: { workspace: string; plan: string }[] };
    expect(body.workspaces).toEqual([expect.objectContaining({ workspace: "acme", plan: "free" })]);
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

// Real in-memory D1 for the galleries endpoint (UsageFakeD1 only knows
// workspace_usage). Mirrors the SQLite stand-in in routes-galleries.test.ts.
class SQLiteStatement {
  values: unknown[] = [];
  constructor(
    readonly database: DatabaseSync,
    readonly sql: string,
  ) {}
  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }
  all<T>() {
    return Promise.resolve({
      success: true,
      results: this.database.prepare(this.sql).all(...(this.values as SQLInputValue[])) as T[],
      meta: {},
    } as D1Result<T>);
  }
}
class SQLiteD1 {
  constructor(readonly database: DatabaseSync) {}
  prepare(sql: string) {
    return new SQLiteStatement(this.database, sql);
  }
}

function galleriesDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(
    readFileSync(
      fileURLToPath(new NodeURL("../../migrations/20260711180000_galleries.sql", import.meta.url)),
      "utf8",
    ),
  );
  return db;
}

/** AUTH + a single membership → one workspace. */
function memberEnv(opts: {
  workspace: string;
  role?: string;
  db: unknown;
  bucket?: FakeR2Bucket;
  record?: unknown;
  /** Issue #445: the auth-side subscription (or null) GET
   * /internal/orgs/:slug/subscription should answer with. Omitted = no
   * subscription row (matches the auth fixture's default `subscription: null`). */
  subscription?: unknown;
}): Env {
  const { workspace, role = "member", db, bucket, record, subscription = null } = opts;
  const auth = stubAuth((req) => {
    const url = new URL(req.url);
    if (url.pathname === "/api/auth/get-session") {
      return new Response(JSON.stringify({ session: {}, user: USER }), { status: 200 });
    }
    if (url.pathname === "/internal/memberships") {
      return Response.json([
        {
          organizationId: "org1",
          organizationSlug: workspace,
          organizationName: workspace,
          role,
        },
      ]);
    }
    if (url.pathname === `/internal/orgs/${workspace}`) {
      return Response.json({ organization: { id: "org1", slug: workspace, name: workspace } });
    }
    if (url.pathname === `/internal/orgs/${workspace}/subscription`) {
      return Response.json({ subscription });
    }
    return new Response(null, { status: 404 });
  });
  return {
    AUTH: auth,
    DB: db,
    WEB_ORIGIN: "https://uploads.test",
    REGISTRY: fakeKv(record ? { [`ws:${workspace}`]: record } : {}),
    ...(bucket ? { UPLOADS_DEFAULT: bucket } : {}),
  } as unknown as Env;
}

function metadataDb(
  rows: Array<{ workspace: string; key: string; meta: Record<string, string> }>,
): SQLiteD1 {
  const db = new DatabaseSync(":memory:");
  db.exec(
    readFileSync(
      fileURLToPath(
        new NodeURL("../../migrations/20260713210559_file_metadata.sql", import.meta.url),
      ),
      "utf8",
    ),
  );
  const insert = db.prepare(
    "INSERT INTO file_metadata (workspace, object_key, meta_key, meta_value, updated_at) VALUES (?, ?, ?, ?, ?)",
  );
  for (const row of rows) {
    for (const [k, v] of Object.entries(row.meta)) {
      insert.run(row.workspace, row.key, k, v, "2026-07-13T00:00:00.000Z");
    }
  }
  return new SQLiteD1(db);
}

const R2_RECORD = {
  provider: "r2",
  bucket: "shared",
  binding: "UPLOADS_DEFAULT",
  prefix: "acme/",
  publicBaseUrl: "https://storage.uploads.sh",
};

describe("GET /me/workspaces/:name/summary", () => {
  it("returns membership + usage + public URL in one payload", async () => {
    const db = new UsageFakeD1();
    db.usage.set("acme", {
      workspace: "acme",
      bytes: 1024,
      objects: 2,
      uploads_in_period: 3,
      period_start: "2026-07",
      updated_at: "2026-07-21T00:00:00.000Z",
    });
    const env = memberEnv({ workspace: "acme", role: "owner", db, record: R2_RECORD });
    const res = await app().request("/me/workspaces/acme/summary", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      workspace: "acme",
      role: "owner",
      hasPublicUrl: true,
      publicBaseUrl: "https://storage.uploads.sh",
      usage: { workspace: "acme", bytes: 1024, objects: 2, uploadsInPeriod: 3 },
    });
  });

  it("404s when the caller is not a member", async () => {
    const env = stubEnv(USER, (path) => {
      if (path === "/internal/memberships") return Response.json([]);
      return new Response(null, { status: 404 });
    });
    const res = await app().request("/me/workspaces/acme/summary", {}, env);
    expect(res.status).toBe(404);
  });
});

describe("GET /me/workspaces/:name/billing", () => {
  it("displays free with planApplied=false and unlimited (explicit-or-null) limits for a record with no plan field", async () => {
    // R2_RECORD has no `plan` field — same "legacy/unset" shape budget.ts's
    // enforcement treats as unlimited (explicit overrides only). The
    // billing tab must never show free-plan default caps (250MB etc.) as
    // if they were real limits here — see workspace-plan.ts's
    // `planResponse` doc comment and Task 5's Critical fix on the admin
    // surface.
    const db = new UsageFakeD1();
    db.usage.set("acme", {
      workspace: "acme",
      bytes: 500,
      objects: 3,
      uploads_in_period: 2,
      period_start: "2026-07",
      updated_at: "2026-07-10T00:00:00.000Z",
    });
    const env = memberEnv({ workspace: "acme", role: "member", db, record: R2_RECORD });
    const res = await app().request("/me/workspaces/acme/billing", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workspace: string;
      plan: string;
      available: boolean;
      planApplied: boolean;
      limits: Record<string, number | null>;
      planSource: string;
      subscription: null;
    };
    expect(body.workspace).toBe("acme");
    expect(body.plan).toBe("free");
    expect(body.available).toBe(true);
    expect(body.planApplied).toBe(false);
    expect(body.limits.maxStorageBytes).toBeNull();
    expect(body.planSource).toBe("none");
    expect(body.subscription).toBeNull();
  });

  it("404s for a non-member", async () => {
    const env = stubEnv(USER, (path) => {
      if (path === "/internal/memberships") return Response.json([]);
      return new Response(null, { status: 404 });
    });
    const res = await app().request("/me/workspaces/acme/billing", {}, env);
    expect(res.status).toBe(404);
  });

  it("reports free with planApplied=true and resolved plan-default limits when the record has an explicit free plan", async () => {
    const db = new UsageFakeD1();
    const env = memberEnv({
      workspace: "acme",
      role: "member",
      db,
      record: { ...R2_RECORD, plan: "free" },
    });
    const res = await app().request("/me/workspaces/acme/billing", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      plan: string;
      available: boolean;
      planApplied: boolean;
      limits: Record<string, number | null>;
    };
    expect(body.plan).toBe("free");
    expect(body.available).toBe(true);
    expect(body.planApplied).toBe(true);
    expect(body.limits.maxStorageBytes).toBe(250_000_000);
  });

  it("reports pro plan, planApplied=true, and pro's own resolved limits when the workspace is on pro", async () => {
    const db = new UsageFakeD1();
    const env = memberEnv({
      workspace: "acme",
      role: "member",
      db,
      record: { ...R2_RECORD, plan: "pro" },
    });
    const res = await app().request("/me/workspaces/acme/billing", {}, env);
    const body = (await res.json()) as {
      plan: string;
      available: boolean;
      planApplied: boolean;
      limits: Record<string, number | null>;
    };
    expect(body.plan).toBe("pro");
    expect(body.available).toBe(true);
    expect(body.planApplied).toBe(true);
    expect(body.limits.maxStorageBytes).toBe(10_000_000_000);
  });

  it("reports planSource 'admin' for a pro workspace with no backing Stripe subscription", async () => {
    const db = new UsageFakeD1();
    const env = memberEnv({
      workspace: "acme",
      db,
      record: { ...R2_RECORD, plan: "pro" },
      subscription: null,
    });
    const res = await app().request("/me/workspaces/acme/billing", {}, env);
    const body = (await res.json()) as { planSource: string; subscription: unknown };
    expect(body.planSource).toBe("admin");
    expect(body.subscription).toBeNull();
  });

  it("reports planSource 'stripe' and the subscription fields (never stripeCustomerId) for a pro workspace backed by an active Stripe subscription", async () => {
    const db = new UsageFakeD1();
    const env = memberEnv({
      workspace: "acme",
      db,
      record: { ...R2_RECORD, plan: "pro" },
      subscription: {
        status: "active",
        periodEnd: "2026-08-15T00:00:00.000Z",
        cancelAtPeriodEnd: true,
        stripeCustomerId: "cus_123",
        plan: "pro",
      },
    });
    const res = await app().request("/me/workspaces/acme/billing", {}, env);
    const body = (await res.json()) as {
      planSource: string;
      subscription: Record<string, unknown> | null;
    };
    expect(body.planSource).toBe("stripe");
    expect(body.subscription).toEqual({
      status: "active",
      periodEnd: "2026-08-15T00:00:00.000Z",
      cancelAtPeriodEnd: true,
    });
    expect(body.subscription).not.toHaveProperty("stripeCustomerId");
  });
});

describe("GET /me/workspaces/:name/people", () => {
  it("returns members + invites for an admin in one authz pass", async () => {
    const env = stubEnv(USER, (path) => {
      if (path === "/internal/memberships") {
        return Response.json([
          {
            organizationId: "org1",
            organizationSlug: "acme",
            organizationName: "Acme Inc",
            role: "admin",
          },
        ]);
      }
      if (path === "/internal/orgs/acme/members") {
        return Response.json({
          members: [
            { id: "m1", userId: "u1", email: "a@b.com", name: "Ada", role: "owner" },
            { id: "m2", userId: "u2", email: "c@d.com", name: null, role: "member" },
          ],
        });
      }
      if (path === "/internal/orgs/acme/invites") {
        return Response.json({
          invites: [{ id: "i1", email: "x@y.com", role: "member", status: "pending" }],
        });
      }
      return new Response(null, { status: 404 });
    });
    const res = await app().request("/me/workspaces/acme/people", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      role: "admin",
      canManage: true,
      organization: { id: "org1", slug: "acme", name: "Acme Inc" },
      members: [
        { id: "m1", email: "a@b.com", name: "Ada", role: "owner" },
        { id: "m2", email: "c@d.com", name: "", role: "member" },
      ],
      invites: [{ id: "i1", email: "x@y.com", role: "member", status: "pending" }],
    });
  });

  it("omits invites for a non-admin member", async () => {
    const env = stubEnv(USER, (path) => {
      if (path === "/internal/memberships") {
        return Response.json([
          {
            organizationId: "org1",
            organizationSlug: "acme",
            organizationName: "Acme Inc",
            role: "member",
          },
        ]);
      }
      if (path === "/internal/orgs/acme/members") {
        return Response.json({
          members: [{ id: "m1", userId: "u1", email: "a@b.com", name: "Ada", role: "owner" }],
        });
      }
      return new Response(null, { status: 404 });
    });
    const res = await app().request("/me/workspaces/acme/people", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      canManage: false,
      members: [{ email: "a@b.com", name: "Ada", role: "owner" }],
      invites: [],
    });
  });
});

describe("GET /me/workspaces/:name/members", () => {
  it("404s for a workspace the caller is not a member of", async () => {
    const env = stubEnv(USER, (path) => {
      if (path === "/internal/memberships") return Response.json([]);
      return new Response(null, { status: 404 });
    });
    const res = await app().request("/me/workspaces/acme/members", {}, env);
    expect(res.status).toBe(404);
  });

  it("returns sanitized member rows for a workspace named 'default' just like any other", async () => {
    const env = stubEnv(USER, (path) => {
      if (path === "/internal/memberships") {
        return Response.json([
          { organizationId: "org1", organizationSlug: "default", role: "member" },
        ]);
      }
      if (path === "/internal/orgs/default") {
        return Response.json({ organization: { id: "org1", slug: "default", name: "Default" } });
      }
      if (path === "/internal/orgs/default/members") {
        return Response.json({
          members: [{ id: "m1", userId: "u1", email: "a@b.com", name: "Ada", role: "owner" }],
        });
      }
      return new Response(null, { status: 404 });
    });
    const res = await app().request("/me/workspaces/default/members", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      members: [{ email: "a@b.com", name: "Ada", role: "owner" }],
    });
  });

  it("returns sanitized member rows for a member's workspace", async () => {
    const env = stubEnv(USER, (path) => {
      if (path === "/internal/memberships") {
        return Response.json([
          { organizationId: "org1", organizationSlug: "acme", role: "member" },
        ]);
      }
      if (path === "/internal/orgs/acme") {
        return Response.json({ organization: { id: "org1", slug: "acme", name: "Acme Inc" } });
      }
      if (path === "/internal/orgs/acme/members") {
        return Response.json({
          members: [
            {
              id: "m1",
              userId: "u1",
              email: "a@b.com",
              name: "Ada",
              role: "owner",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
            { id: "m2", userId: "u2", email: "c@d.com", name: null, role: "member" },
          ],
        });
      }
      return new Response(null, { status: 404 });
    });
    const res = await app().request("/me/workspaces/acme/members", {}, env);
    expect(res.status).toBe(200);
    // Internal `id`/`userId` never reach the member-facing payload.
    expect(await res.json()).toEqual({
      members: [
        { email: "a@b.com", name: "Ada", role: "owner", createdAt: "2026-01-01T00:00:00.000Z" },
        { email: "c@d.com", name: "", role: "member" },
      ],
    });
  });
});

describe("GET /me/workspaces/:name/members id exposure", () => {
  function membersEnv(role: string): Env {
    return stubEnv(USER, (path) => {
      if (path === "/internal/memberships") {
        return Response.json([{ organizationId: "org1", organizationSlug: "acme", role }]);
      }
      if (path === "/internal/orgs/acme") {
        return Response.json({ organization: { id: "org1", slug: "acme", name: "Acme Inc" } });
      }
      if (path === "/internal/orgs/acme/members") {
        return Response.json({
          members: [
            {
              id: "m1",
              userId: "u1",
              email: "a@b.com",
              name: "Ada",
              role: "owner",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        });
      }
      return new Response(null, { status: 404 });
    });
  }

  it("includes member id for an admin/owner caller", async () => {
    const env = membersEnv("owner");
    const res = await app().request("/me/workspaces/acme/members", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: Record<string, unknown>[] };
    expect(body.members[0]).toHaveProperty("id", "m1");
  });

  it("includes member id for an admin caller", async () => {
    const env = membersEnv("admin");
    const res = await app().request("/me/workspaces/acme/members", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: Record<string, unknown>[] };
    expect(body.members[0]).toHaveProperty("id", "m1");
  });

  it("omits member id for a plain member caller", async () => {
    const env = membersEnv("member");
    const res = await app().request("/me/workspaces/acme/members", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: Record<string, unknown>[] };
    expect(body.members[0]).not.toHaveProperty("id");
  });
});

describe("member management routes", () => {
  function manageEnv(opts: {
    workspace?: string;
    role: string;
    onManage?: (path: string, req: Request) => Response | Promise<Response> | undefined;
  }): Env {
    const { workspace = "acme", role, onManage } = opts;
    const auth = stubAuth(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/auth/get-session") {
        return new Response(JSON.stringify({ session: {}, user: USER }), { status: 200 });
      }
      if (url.pathname === "/internal/memberships") {
        return Response.json([{ organizationId: "org1", organizationSlug: workspace, role }]);
      }
      if (url.pathname === `/internal/orgs/${workspace}`) {
        return Response.json({ organization: { id: "org1", slug: workspace, name: workspace } });
      }
      const handled = onManage?.(url.pathname, req);
      if (handled) return handled;
      if (url.pathname === `/internal/orgs/${workspace}/invites`) {
        return Response.json({ invites: [] });
      }
      if (
        url.pathname.startsWith(`/internal/orgs/${workspace}/invites/`) &&
        req.method === "DELETE"
      ) {
        return Response.json({ ok: true });
      }
      if (
        url.pathname.startsWith(`/internal/orgs/${workspace}/members/`) &&
        req.method === "DELETE"
      ) {
        return Response.json({ ok: true });
      }
      if (
        url.pathname.startsWith(`/internal/orgs/${workspace}/members/`) &&
        req.method === "PATCH"
      ) {
        return Response.json({ member: { id: "m1", userId: "u1", role: "admin" } });
      }
      return new Response(null, { status: 404 });
    });
    return { AUTH: auth, DB: new UsageFakeD1() } as unknown as Env;
  }

  it("GET invites requires admin/owner (403 for a member)", async () => {
    const env = manageEnv({ role: "member" });
    const res = await app().request("/me/workspaces/acme/invites", {}, env);
    expect(res.status).toBe(403);
  });

  it("GET invites returns pending invites for an admin", async () => {
    const env = manageEnv({ role: "admin" });
    const res = await app().request("/me/workspaces/acme/invites", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { invites: unknown[] };
    expect(body.invites).toBeInstanceOf(Array);
  });

  it("DELETE invites revokes for an admin/owner", async () => {
    const env = manageEnv({ role: "owner" });
    const res = await app().request("/me/workspaces/acme/invites/inv1", { method: "DELETE" }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("DELETE invites 403s for a plain member", async () => {
    const env = manageEnv({ role: "member" });
    const res = await app().request("/me/workspaces/acme/invites/inv1", { method: "DELETE" }, env);
    expect(res.status).toBe(403);
  });

  it("DELETE members removes a member for an admin/owner", async () => {
    const env = manageEnv({ role: "owner" });
    const res = await app().request("/me/workspaces/acme/members/m1", { method: "DELETE" }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("DELETE members 403s for a plain member", async () => {
    const env = manageEnv({ role: "member" });
    const res = await app().request("/me/workspaces/acme/members/m1", { method: "DELETE" }, env);
    expect(res.status).toBe(403);
  });

  it("PATCH members changes the role for an owner", async () => {
    const env = manageEnv({ role: "owner" });
    const res = await app().request(
      "/me/workspaces/acme/members/m1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "admin" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { member: { role: string } };
    expect(body.member.role).toBe("admin");
  });

  it("PATCH members changes the role for a workspace admin", async () => {
    const env = manageEnv({ role: "admin" });
    const res = await app().request(
      "/me/workspaces/acme/members/m1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "admin" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { member: { role: string } };
    expect(body.member.role).toBe("admin");
  });

  it("PATCH members validates the role", async () => {
    const env = manageEnv({ role: "owner" });
    const res = await app().request(
      "/me/workspaces/acme/members/m1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "owner" }),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "invalid_role" },
    });
  });

  it("PATCH members 403s for a plain member", async () => {
    const env = manageEnv({ role: "member" });
    const res = await app().request(
      "/me/workspaces/acme/members/m1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "admin" }),
      },
      env,
    );
    expect(res.status).toBe(403);
  });

  it("returns invites for a workspace named 'default' just like any other", async () => {
    const env = manageEnv({ workspace: "default", role: "owner" });
    const res = await app().request("/me/workspaces/default/invites", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ invites: [] });
  });
});

describe("GET /me/workspaces/:name/galleries", () => {
  it("404s for a workspace the caller is not a member of", async () => {
    const env = stubEnv(USER, (path) => {
      if (path === "/internal/memberships") return Response.json([]);
      return new Response(null, { status: 404 });
    });
    const res = await app().request("/me/workspaces/acme/galleries", {}, env);
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "workspace_not_found" },
    });
  });

  it("returns an empty gallery list for a workspace named 'default' just like any other", async () => {
    const db = galleriesDb();
    const env = memberEnv({ workspace: "default", db: new SQLiteD1(db) });
    const res = await app().request("/me/workspaces/default/galleries", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ galleries: [] });
  });

  it("returns gallery summaries for a member's workspace", async () => {
    const db = galleriesDb();
    db.exec(
      `INSERT INTO galleries
         (id, workspace, title, description, visibility, cover_item_id, version, created_at, updated_at, deleted_at)
       VALUES
         ('gal_aaaaaaaaaaaaaaaaaaaaaa', 'acme', 'Launch media', NULL, 'public', NULL, 1,
          '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', NULL)`,
    );
    const env = memberEnv({ workspace: "acme", db: new SQLiteD1(db) });
    const res = await app().request("/me/workspaces/acme/galleries", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      galleries: [
        {
          id: "gal_aaaaaaaaaaaaaaaaaaaaaa",
          url: "https://uploads.test/g/gal_aaaaaaaaaaaaaaaaaaaaaa",
          workspace: "acme",
          title: "Launch media",
          description: null,
          visibility: "public",
          coverItemId: null,
          version: 1,
          createdAt: "2026-07-01T00:00:00.000Z",
          updatedAt: "2026-07-01T00:00:00.000Z",
          itemCount: 0,
          references: [],
        },
      ],
    });
  });

  it("includes item counts and linked PR/issue references on each row", async () => {
    const db = galleriesDb();
    db.exec(
      `INSERT INTO galleries
         (id, workspace, title, description, visibility, cover_item_id, version, created_at, updated_at, deleted_at)
       VALUES
         ('gal_bbbbbbbbbbbbbbbbbbbbbb', 'acme', 'PR screenshots', NULL, 'public', NULL, 1,
          '2026-07-02T00:00:00.000Z', '2026-07-03T00:00:00.000Z', NULL);
       INSERT INTO gallery_items
         (id, gallery_id, object_key, position, caption, alt_text, created_at)
       VALUES
         ('item_1', 'gal_bbbbbbbbbbbbbbbbbbbbbb', 'screenshots/a.png', 1, NULL, NULL, '2026-07-02T00:00:00.000Z'),
         ('item_2', 'gal_bbbbbbbbbbbbbbbbbbbbbb', 'screenshots/b.png', 2, NULL, NULL, '2026-07-02T00:01:00.000Z');
       INSERT INTO gallery_external_references
         (id, gallery_id, provider, resource_type, normalized_key, locator_json, canonical_url, created_at, updated_at)
       VALUES
         ('ref_1', 'gal_bbbbbbbbbbbbbbbbbbbbbb', 'github', 'item',
          'github:buildinternet/uploads#58',
          '{"owner":"buildinternet","repository":"uploads","number":58}',
          'https://github.com/buildinternet/uploads/pull/58',
          '2026-07-02T00:00:00.000Z', '2026-07-02T00:00:00.000Z')`,
    );
    const env = memberEnv({ workspace: "acme", db: new SQLiteD1(db) });
    const res = await app().request("/me/workspaces/acme/galleries", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      galleries: Array<{
        id: string;
        itemCount: number;
        references: Array<{ coordinate: string; canonicalUrl: string | null }>;
      }>;
    };
    expect(body.galleries).toHaveLength(1);
    expect(body.galleries[0]).toMatchObject({
      id: "gal_bbbbbbbbbbbbbbbbbbbbbb",
      itemCount: 2,
      references: [
        {
          coordinate: "buildinternet/uploads#58",
          canonicalUrl: "https://github.com/buildinternet/uploads/pull/58",
        },
      ],
    });
  });
});

describe("GET /me/workspaces/:name/files", () => {
  it("returns a page of files with public URLs for a member's workspace", async () => {
    const bucket = new FakeR2Bucket();
    await bucket.put("acme/f/x/shot.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const env = memberEnv({
      workspace: "acme",
      db: new UsageFakeD1(),
      bucket,
      record: {
        provider: "r2",
        bucket: "shared",
        binding: "UPLOADS_DEFAULT",
        prefix: "acme/",
        publicBaseUrl: "https://storage.uploads.sh",
      },
    });
    const res = await app().request("/me/workspaces/acme/files", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      files: { key: string; url: string; pageUrl?: string }[];
    };
    expect(body.files).toHaveLength(1);
    expect(body.files[0]).toMatchObject({
      key: "f/x/shot.png",
      url: "https://storage.uploads.sh/acme/f/x/shot.png",
    });
    // #303: this route never passed `workspaceName` into listObjects, so
    // pageUrl was always missing here — loadWorkspaceRecord now stamps
    // `name` from the lookup key, so listObjects computes it unconditionally.
    expect(body.files[0].pageUrl).toBe("https://uploads.test/f/acme/f/x/shot.png");
  });

  it("lists a folder with prefix and hydrates gh.* metadata + public urls", async () => {
    const bucket = new FakeR2Bucket();
    await bucket.put(
      "acme/screenshots/releases/1789/a.png",
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      { httpMetadata: { contentType: "image/png" } },
    );
    const db = metadataDb([
      {
        workspace: "acme",
        key: "screenshots/releases/1789/a.png",
        meta: {
          "gh.repo": "o/uploads",
          "gh.kind": "pull",
          "gh.number": "1789",
          "gh.ref": "o/uploads#1789",
        },
      },
    ]);
    const env = memberEnv({ workspace: "acme", role: "admin", db, bucket, record: R2_RECORD });

    const res = await app().request(
      "/me/workspaces/acme/files?prefix=screenshots/releases/1789/",
      {},
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      files: {
        key: string;
        url: string;
        embedUrl: string;
        contentType: string;
        metadata?: Record<string, string>;
      }[];
    };
    const file = body.files.find((f) => f.key.endsWith("a.png"));
    expect(file?.contentType).toBe("image/png");
    expect(file?.url).toContain("storage.uploads.sh");
    expect(file?.embedUrl).toContain("embed.uploads.sh");
    expect(file?.metadata).toEqual({
      "gh.repo": "o/uploads",
      "gh.kind": "pull",
      "gh.number": "1789",
      "gh.ref": "o/uploads#1789",
    });
  });

  it("omits metadata for a key with no D1 rows", async () => {
    const bucket = new FakeR2Bucket();
    await bucket.put("acme/f/x/shot.png", new Uint8Array([1]));
    const env = memberEnv({
      workspace: "acme",
      db: metadataDb([]),
      bucket,
      record: R2_RECORD,
    });
    const res = await app().request("/me/workspaces/acme/files", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: { key: string; metadata?: unknown }[] };
    expect(body.files[0].key).toBe("f/x/shot.png");
    expect(body.files[0].metadata).toBeUndefined();
  });

  it("returns common prefixes as folders when delimiter is given", async () => {
    const bucket = new FakeR2Bucket();
    await bucket.put("acme/screenshots/releases/1789/a.png", new Uint8Array([1]));
    await bucket.put("acme/screenshots/releases/1790/b.png", new Uint8Array([1]));
    const env = memberEnv({
      workspace: "acme",
      db: new UsageFakeD1(),
      bucket,
      record: R2_RECORD,
    });
    const res = await app().request(
      "/me/workspaces/acme/files?prefix=screenshots/releases/&delimiter=/",
      {},
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: unknown[]; prefixes?: string[] };
    expect(body.files).toEqual([]);
    expect(body.prefixes).toEqual(
      expect.arrayContaining(["screenshots/releases/1789/", "screenshots/releases/1790/"]),
    );
  });
});

describe("GET /me/workspaces/:name/file-url", () => {
  it("404s for a workspace the caller is not a member of", async () => {
    const env = stubEnv(USER, (path) => {
      if (path === "/internal/memberships") return Response.json([]);
      return new Response(null, { status: 404 });
    });
    const res = await app().request("/me/workspaces/acme/file-url?key=a.png", {}, env);
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "workspace_not_found" },
    });
  });

  it("404s for an invalid key", async () => {
    const bucket = new FakeR2Bucket();
    const env = memberEnv({
      workspace: "acme",
      db: new UsageFakeD1(),
      bucket,
      record: {
        provider: "r2",
        bucket: "shared",
        binding: "UPLOADS_DEFAULT",
        prefix: "acme/",
        publicBaseUrl: "https://storage.uploads.sh",
      },
    });
    const res = await app().request(
      "/me/workspaces/acme/file-url?key=" + encodeURIComponent("../etc/passwd"),
      {},
      env,
    );
    expect(res.status).toBe(404);
  });

  it("404s for a key that does not exist in the bucket", async () => {
    const bucket = new FakeR2Bucket();
    const env = memberEnv({
      workspace: "acme",
      db: new UsageFakeD1(),
      bucket,
      record: {
        provider: "r2",
        bucket: "shared",
        binding: "UPLOADS_DEFAULT",
        prefix: "acme/",
        publicBaseUrl: "https://storage.uploads.sh",
      },
    });
    const res = await app().request("/me/workspaces/acme/file-url?key=missing.png", {}, env);
    expect(res.status).toBe(404);
  });

  it("prefers the stable public URL when publicBaseUrl is configured", async () => {
    const bucket = new FakeR2Bucket();
    await bucket.put("acme/a.png", new Uint8Array([1]));
    const env = memberEnv({
      workspace: "acme",
      db: new UsageFakeD1(),
      bucket,
      record: {
        provider: "r2",
        bucket: "shared",
        binding: "UPLOADS_DEFAULT",
        prefix: "acme/",
        publicBaseUrl: "https://storage.uploads.sh",
        // Hybrid signing creds are also present — publicBaseUrl must still win.
        accountId: "acct",
        accessKeyId: "key",
        secretAccessKey: "secret",
      },
    });
    const res = await app().request("/me/workspaces/acme/file-url?key=a.png", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://storage.uploads.sh/acme/a.png" });
  });

  it("falls back to a short-lived signed URL when the provider has signing credentials but no publicBaseUrl", async () => {
    const bucket = new FakeR2Bucket();
    await bucket.put("acme/a.png", new Uint8Array([1]));
    const env = memberEnv({
      workspace: "acme",
      db: new UsageFakeD1(),
      bucket,
      record: {
        provider: "r2",
        bucket: "shared",
        binding: "UPLOADS_DEFAULT",
        prefix: "acme/",
        accountId: "acct",
        accessKeyId: "key",
        secretAccessKey: "secret",
      },
    });
    const res = await app().request("/me/workspaces/acme/file-url?key=a.png", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toMatch(/^https:\/\/acct\.r2\.cloudflarestorage\.com\/shared\/acme\/a\.png\?/);
    expect(body.url).toContain("response-content-disposition=attachment");
  });

  it("returns a typed error for a binding-only workspace with no publicBaseUrl or signing credentials", async () => {
    const bucket = new FakeR2Bucket();
    await bucket.put("acme/a.png", new Uint8Array([1]));
    const env = memberEnv({
      workspace: "acme",
      db: new UsageFakeD1(),
      bucket,
      record: {
        provider: "r2",
        bucket: "shared",
        binding: "UPLOADS_DEFAULT",
        prefix: "acme/",
      },
    });
    const res = await app().request("/me/workspaces/acme/file-url?key=a.png", {}, env);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "file_url_unavailable" },
    });
  });
});

describe("PATCH /me/workspaces/:name/files/visibility", () => {
  function patchVisibility(name: string, key: string, visibility: unknown, env: Env) {
    return app().request(
      `/me/workspaces/${name}/files/visibility?key=${encodeURIComponent(key)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility }),
      },
      env,
    );
  }

  function acmeEnv(bucket: FakeR2Bucket) {
    return memberEnv({
      workspace: "acme",
      db: new UsageFakeD1(),
      bucket,
      record: {
        provider: "r2",
        bucket: "shared",
        binding: "UPLOADS_DEFAULT",
        prefix: "acme/",
        publicBaseUrl: "https://storage.uploads.sh",
      },
    });
  }

  it("flips a public file to private and back, preserving provenance metadata", async () => {
    const bucket = new FakeR2Bucket();
    await bucket.put("acme/a.png", new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: "image/png" },
      customMetadata: { "source-name": "a.png", "content-sha256": "abc123" },
    });
    const env = acmeEnv(bucket);

    const toPrivate = await patchVisibility("acme", "a.png", "private", env);
    expect(toPrivate.status).toBe(200);
    expect(await toPrivate.json()).toEqual({ key: "a.png", visibility: "private" });

    const stored = bucket.store.get("acme/a.png");
    expect(stored?.customMetadata).toEqual({
      "source-name": "a.png",
      "content-sha256": "abc123",
      visibility: "private",
    });
    expect(stored?.contentType).toBe("image/png");
    expect(Array.from(stored!.data)).toEqual([1, 2, 3]);

    const toPublic = await patchVisibility("acme", "a.png", "public", env);
    expect(toPublic.status).toBe(200);
    expect(await toPublic.json()).toEqual({ key: "a.png", visibility: "public" });

    const storedAgain = bucket.store.get("acme/a.png");
    expect(storedAgain?.customMetadata).toEqual({
      "source-name": "a.png",
      "content-sha256": "abc123",
    });
  });

  it("429s when the workspace write limiter is over budget", async () => {
    const bucket = new FakeR2Bucket();
    await bucket.put("acme/a.png", new Uint8Array([1]), {
      httpMetadata: { contentType: "image/png" },
    });
    const env = {
      ...acmeEnv(bucket),
      WRITE_LIMITER: { limit: async () => ({ success: false }) },
    } as unknown as Env;

    const res = await patchVisibility("acme", "a.png", "private", env);
    expect(res.status).toBe(429);
    expect(bucket.store.get("acme/a.png")?.customMetadata ?? {}).not.toHaveProperty("visibility");
  });

  it("404s for a workspace the caller is not a member of", async () => {
    const env = stubEnv(USER, (path) => {
      if (path === "/internal/memberships") return Response.json([]);
      return new Response(null, { status: 404 });
    });
    const res = await patchVisibility("acme", "a.png", "private", env);
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "workspace_not_found" },
    });
  });

  it("404s for a bad key", async () => {
    const env = acmeEnv(new FakeR2Bucket());
    const res = await patchVisibility("acme", "../etc/passwd", "private", env);
    expect(res.status).toBe(404);
  });

  it("404s for a key that does not exist", async () => {
    const env = acmeEnv(new FakeR2Bucket());
    const res = await patchVisibility("acme", "missing.png", "private", env);
    expect(res.status).toBe(404);
  });

  it("400s for an invalid visibility value", async () => {
    const bucket = new FakeR2Bucket();
    await bucket.put("acme/a.png", new Uint8Array([1]));
    const env = acmeEnv(bucket);
    const res = await patchVisibility("acme", "a.png", "hidden", env);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "invalid_visibility" },
    });
  });

  it("400s for a missing visibility field", async () => {
    const bucket = new FakeR2Bucket();
    await bucket.put("acme/a.png", new Uint8Array([1]));
    const env = acmeEnv(bucket);
    const res = await patchVisibility("acme", "a.png", undefined, env);
    expect(res.status).toBe(400);
  });
});

describe("/me/workspaces/:name/file-browser", () => {
  function browserEnv(workspace = "acme") {
    const bucket = new FakeR2Bucket();
    const env = memberEnv({
      workspace,
      db: new UsageFakeD1(),
      bucket,
      record: {
        provider: "r2",
        bucket: "shared",
        binding: "UPLOADS_DEFAULT",
        prefix: `${workspace}/`,
        publicBaseUrl: "https://storage.uploads.sh",
      },
    });
    return { bucket, env };
  }

  it("lists folders through files-sdk without exposing the storage prefix", async () => {
    const { bucket, env } = browserEnv();
    await bucket.put("acme/f/x/shot.png", new Uint8Array([1]));
    await bucket.put("acme/readme.txt", new Uint8Array([2]));
    await bucket.put("other/secret.txt", new Uint8Array([3]));

    const res = await app().request(
      "/me/workspaces/acme/file-browser",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "list", delimiter: "/" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { key: string }[]; prefixes: string[] };
    expect(body.items.map((item) => item.key)).toEqual(["readme.txt"]);
    expect(body.prefixes).toEqual(["f/"]);
    expect(JSON.stringify(body)).not.toContain("other/secret.txt");
    expect(JSON.stringify(body)).not.toContain("acme/");

    const urlRes = await app().request("/me/workspaces/acme/file-url?key=readme.txt", {}, env);
    expect(urlRes.status).toBe(200);
    expect(await urlRes.json()).toEqual({ url: "https://storage.uploads.sh/acme/readme.txt" });
  });

  it("rejects mutation operations even for a workspace member", async () => {
    const { env } = browserEnv();
    const res = await app().request(
      "/me/workspaces/acme/file-browser",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "delete", key: "readme.txt" }),
      },
      env,
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /me/workspaces/:name/invites", () => {
  function inviteEnv(opts: {
    role: string;
    onInvite?: (body: unknown) => Response | Promise<Response>;
  }): Env {
    const { role, onInvite } = opts;
    const auth = stubAuth(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/auth/get-session") {
        return new Response(JSON.stringify({ session: {}, user: USER }), { status: 200 });
      }
      if (url.pathname === "/internal/memberships") {
        return Response.json([{ organizationId: "org1", organizationSlug: "acme", role }]);
      }
      if (url.pathname === "/internal/orgs/acme") {
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
    return { AUTH: auth, DB: new UsageFakeD1() } as unknown as Env;
  }

  it("lets an org owner invite a teammate", async () => {
    let captured: unknown;
    const env = inviteEnv({
      role: "owner",
      onInvite: (body) => {
        captured = body;
        return Response.json(
          { invitation: { id: "inv1", email: "t@example.com", status: "pending" } },
          { status: 201 },
        );
      },
    });
    const res = await app().request(
      "/me/workspaces/acme/invites",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "t@example.com" }),
      },
      env,
    );
    expect(res.status).toBe(201);
    expect(captured).toMatchObject({
      organizationSlug: "acme",
      email: "t@example.com",
      role: "member",
      inviterUserId: USER.id,
    });
  });

  it("403s for an org member without admin/owner", async () => {
    const env = inviteEnv({ role: "member" });
    const res = await app().request(
      "/me/workspaces/acme/invites",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "t@example.com" }),
      },
      env,
    );
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "workspace_admin_required" },
    });
  });

  it("404s for a workspace the caller is not a member of", async () => {
    const env = stubEnv(USER, (path) => {
      if (path === "/internal/memberships") return Response.json([]);
      return new Response(null, { status: 404 });
    });
    const res = await app().request(
      "/me/workspaces/acme/invites",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "t@example.com" }),
      },
      env,
    );
    expect(res.status).toBe(404);
  });

  it("400s on an invalid email", async () => {
    const env = inviteEnv({ role: "admin" });
    const res = await app().request(
      "/me/workspaces/acme/invites",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "not-an-email" }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /me/workspaces/:name/files/search", () => {
  it("returns files matching an ANDed metadata filter", async () => {
    const db = metadataDb([
      {
        workspace: "acme",
        key: "f/x/shot.png",
        meta: { "gh.repo": "buildinternet/uploads", app: "web" },
      },
      { workspace: "acme", key: "f/y/other.png", meta: { "gh.repo": "buildinternet/uploads" } },
    ]);
    const env = memberEnv({ workspace: "acme", db, bucket: new FakeR2Bucket(), record: R2_RECORD });
    const res = await app().request(
      "/me/workspaces/acme/files/search?meta.gh.repo=buildinternet/uploads&meta.app=web",
      {},
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { key: string; url: string; metadata: Record<string, string> }[];
      truncated: boolean;
    };
    expect(body.truncated).toBe(false);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      key: "f/x/shot.png",
      url: "https://storage.uploads.sh/acme/f/x/shot.png",
    });
  });

  it("rejects a repeated filter key with file_metadata_duplicate_filter", async () => {
    const env = memberEnv({ workspace: "acme", db: metadataDb([]), record: R2_RECORD });
    const res = await app().request(
      "/me/workspaces/acme/files/search?meta.app=web&meta.app=api",
      {},
      env,
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "file_metadata_duplicate_filter" },
    });
  });

  it("rejects a malformed filter key with file_metadata_invalid_key", async () => {
    const env = memberEnv({ workspace: "acme", db: metadataDb([]), record: R2_RECORD });
    const res = await app().request("/me/workspaces/acme/files/search?meta.BadKey=x", {}, env);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "file_metadata_invalid_key" },
    });
  });

  it("requires at least one meta.* filter", async () => {
    const env = memberEnv({ workspace: "acme", db: metadataDb([]), record: R2_RECORD });
    const res = await app().request("/me/workspaces/acme/files/search", {}, env);
    expect(res.status).toBe(400);
  });

  it("404s for a workspace the caller is not a member of", async () => {
    const env = memberEnv({ workspace: "acme", db: metadataDb([]), record: R2_RECORD });
    const res = await app().request("/me/workspaces/other/files/search?meta.app=web", {}, env);
    expect(res.status).toBe(404);
  });
});
