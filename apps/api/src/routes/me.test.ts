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
          communal: false,
        },
      ],
    });
  });

  it("flags the default workspace as communal", async () => {
    const env = stubEnv(USER, (path) => {
      if (path === "/internal/memberships") {
        return Response.json([
          { organizationId: "org1", organizationSlug: "acme", role: "admin" },
          { organizationId: "org2", organizationSlug: "default", role: "member" },
        ]);
      }
      if (path === "/internal/orgs/acme") {
        return Response.json({ organization: { id: "org1", slug: "acme", name: "Acme Inc" } });
      }
      if (path === "/internal/orgs/default") {
        return Response.json({ organization: { id: "org2", slug: "default", name: "Default" } });
      }
      return new Response(null, { status: 404 });
    });
    const res = await app().request("/me/workspaces", {}, env);
    const body = (await res.json()) as { workspaces: { workspace: string; communal: boolean }[] };
    const byName = Object.fromEntries(body.workspaces.map((w) => [w.workspace, w.communal]));
    expect(byName).toEqual({ acme: false, default: true });
  });

  it("503s when the memberships lookup fails (AUTH outage is not zero memberships)", async () => {
    const env = stubEnv(USER, () => new Response(null, { status: 500 }));
    const res = await app().request("/me/workspaces", {}, env);
    expect(res.status).toBe(503);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "auth_lookup_failed" },
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

/** AUTH + a single membership → one non-communal (or communal) workspace. */
function memberEnv(opts: {
  workspace: string;
  role?: string;
  db: unknown;
  bucket?: FakeR2Bucket;
  record?: unknown;
}): Env {
  const { workspace, role = "member", db, bucket, record } = opts;
  const auth = stubAuth((req) => {
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

  it("short-circuits the communal workspace with an empty list", async () => {
    // The default workspace is communal; the endpoint returns before touching
    // the DB, so UsageFakeD1 (which can't run the galleries query) is fine here.
    const env = memberEnv({ workspace: "default", db: new UsageFakeD1() });
    const res = await app().request("/me/workspaces/default/galleries", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ communal: true, galleries: [] });
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
      communal: false,
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
        },
      ],
    });
  });
});

describe("GET /me/workspaces/:name/files", () => {
  it("short-circuits the communal workspace with an empty list", async () => {
    const env = memberEnv({ workspace: "default", db: new UsageFakeD1() });
    const res = await app().request("/me/workspaces/default/files", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ communal: true, files: [] });
  });

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
      communal: boolean;
      files: { key: string; url: string }[];
    };
    expect(body.communal).toBe(false);
    expect(body.files).toHaveLength(1);
    expect(body.files[0]).toMatchObject({
      key: "f/x/shot.png",
      url: "https://storage.uploads.sh/acme/f/x/shot.png",
    });
  });
});
