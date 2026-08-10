/**
 * Canonical dual-auth galleries vertical (issue #613 phase 2):
 * `/v1/workspaces/:workspace/galleries*`. Exercised through the real
 * composed `app` (index.ts), mirroring `routes-workspace-files.test.ts`
 * (phase 1) and reusing `routes-galleries.test.ts`'s SQLite-backed D1 fake
 * for real gallery CRUD semantics. Bearer-only coverage for the pre-existing
 * `/v1/:workspace/galleries*` handlers stays in `test/routes-galleries.test.ts`
 * (untouched by this phase); this file is scoped to what's new: both
 * credential types reaching the SAME handlers, scope enforcement, and the
 * deliberate non-forwarding of the old `/me/workspaces/:name/galleries` list
 * (see `.context/613-api-consolidation-plan.md`).
 */
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/index";
import { sha256Hex, type WorkspaceRecord } from "../src/workspace";
import { FakeR2Bucket } from "./fake-r2";

const TOKEN = "canonical-gallery-token";
const READ_TOKEN = "canonical-gallery-read-token";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const USER = { id: "u-1", email: "member@example.com", name: "Member" };

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
  first<T>() {
    return Promise.resolve(
      (this.database.prepare(this.sql).get(...(this.values as SQLInputValue[])) as T | undefined) ??
        null,
    );
  }
  all<T>() {
    return Promise.resolve({
      success: true,
      results: this.database.prepare(this.sql).all(...(this.values as SQLInputValue[])) as T[],
      meta: {},
    } as D1Result<T>);
  }
  run() {
    const result = this.database.prepare(this.sql).run(...(this.values as SQLInputValue[]));
    return Promise.resolve({
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    } as unknown as D1Result);
  }
}

class SQLiteD1 {
  constructor(readonly database: DatabaseSync) {}
  prepare(sql: string) {
    return new SQLiteStatement(this.database, sql);
  }
  async batch(statements: SQLiteStatement[]) {
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

beforeAll(() => {
  if (!(crypto.subtle as SubtleCrypto & { timingSafeEqual?: unknown }).timingSafeEqual) {
    Object.defineProperty(crypto.subtle, "timingSafeEqual", {
      value: (left: ArrayBufferView, right: ArrayBufferView) => {
        const a = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
        const b = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
        if (a.length !== b.length) return false;
        let difference = 0;
        for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
        return difference === 0;
      },
    });
  }
});

let db: DatabaseSync;
let bucket: FakeR2Bucket;
let records: Record<string, WorkspaceRecord>;

function migration(name: string) {
  return readFileSync(fileURLToPath(new NodeURL(`../migrations/${name}`, import.meta.url)), "utf8");
}

async function makeEnv(
  opts: { member?: boolean; session?: boolean; getSessionCalls?: { count: number } } = {},
): Promise<Parameters<typeof app.request>[2]> {
  const { member = true, session = true, getSessionCalls } = opts;
  return {
    DB: new SQLiteD1(db) as unknown as D1Database,
    WEB_ORIGIN: "https://uploads.test",
    REGISTRY: { get: async (key: string) => records[key.slice(3)] ?? null },
    UPLOADS_DEFAULT: bucket,
    WRITE_LIMITER: { limit: async () => ({ success: true }) },
    AUTH: {
      fetch: async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.pathname === "/api/auth/get-session") {
          if (getSessionCalls) getSessionCalls.count++;
          return session ? Response.json({ session: {}, user: USER }) : Response.json(null);
        }
        if (url.pathname === "/internal/memberships") {
          return Response.json(
            member
              ? [
                  {
                    organizationId: "org-1",
                    organizationSlug: "acme",
                    organizationName: "Acme",
                    role: "member",
                  },
                ]
              : [],
          );
        }
        return new Response(JSON.stringify({ githubAccountId: null }), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  } as unknown as Parameters<typeof app.request>[2];
}

beforeEach(async () => {
  db = new DatabaseSync(":memory:");
  db.exec(migration("20260710120000_auth.sql"));
  db.exec(migration("20260710140000_workspace_usage.sql"));
  db.exec(migration("20260711180000_galleries.sql"));
  db.exec(migration("20260712230000_token_minting_user.sql"));
  db.exec(migration("20260713210559_file_metadata.sql"));
  db.exec(migration("20260728120000_daily_metrics.sql"));
  bucket = new FakeR2Bucket();
  await bucket.put("acme/screenshots/one.png", PNG);
  records = {
    acme: {
      provider: "r2",
      bucket: "shared",
      binding: "UPLOADS_DEFAULT",
      prefix: "acme/",
      publicBaseUrl: "https://storage.uploads.sh",
      tokenHash: await sha256Hex(TOKEN),
    },
    beta: {
      provider: "r2",
      bucket: "shared",
      binding: "UPLOADS_DEFAULT",
      prefix: "beta/",
      publicBaseUrl: "https://storage.uploads.sh",
      tokenHash: await sha256Hex(TOKEN),
    },
  };
});

async function bearer(path: string, init: RequestInit = {}) {
  return app.request(
    path,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    },
    await makeEnv(),
  );
}

async function createViaCanonical(env: Parameters<typeof app.request>[2]) {
  const res = await app.request(
    "/v1/workspaces/acme/galleries",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Launch media" }),
    },
    env,
  );
  expect(res.status).toBe(201);
  return res.json() as Promise<{ id: string; version: number }>;
}

describe("POST/GET/PATCH/DELETE /v1/workspaces/:workspace/galleries (bearer, canonical CRUD)", () => {
  it("creates, reads, updates, and deletes a gallery", async () => {
    const env = await makeEnv();
    const gallery = await createViaCanonical(env);
    expect(gallery.id).toMatch(/^gal_/);

    const got = await app.request(
      `/v1/workspaces/acme/galleries/${gallery.id}`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(got.status).toBe(200);

    const patched = await app.request(
      `/v1/workspaces/acme/galleries/${gallery.id}`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: 1, title: "Updated" }),
      },
      env,
    );
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ title: "Updated", version: 2 });

    const deleted = await app.request(
      `/v1/workspaces/acme/galleries/${gallery.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: 2 }),
      },
      env,
    );
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true, id: gallery.id });
  });

  it("cross-tenant access 404s (wrong workspace in the path for a bearer token scoped to another)", async () => {
    const env = await makeEnv();
    const gallery = await createViaCanonical(env);
    const res = await app.request(
      `/v1/workspaces/beta/galleries/${gallery.id}`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("gallery_not_found");
  });

  it("401s a bearer token whose hash doesn't match this workspace", async () => {
    const env = await makeEnv();
    const res = await app.request(
      "/v1/workspaces/acme/galleries",
      { headers: { Authorization: "Bearer wrong-token" } },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("a read-scoped token can list but not create (403 insufficient_scope)", async () => {
    const env = await makeEnv();
    const now = new Date().toISOString();
    await (env as unknown as { DB: D1Database }).DB.prepare(
      "INSERT INTO auth_tokens (id, workspace, token_hash, label, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(
        "token-read",
        "acme",
        await sha256Hex(READ_TOKEN),
        null,
        JSON.stringify(["files:read"]),
        now,
      )
      .run();

    const list = await app.request(
      "/v1/workspaces/acme/galleries",
      { headers: { Authorization: `Bearer ${READ_TOKEN}` } },
      env,
    );
    expect(list.status).toBe(200);

    const create = await app.request(
      "/v1/workspaces/acme/galleries",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${READ_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "nope" }),
      },
      env,
    );
    expect(create.status).toBe(403);
    const body = (await create.json()) as { error?: { type?: string } };
    expect(body.error?.type).toBe("insufficient_scope");
  });
});

describe("GET /v1/workspaces/:workspace/galleries (session auth)", () => {
  it("a member reaches the same handler as a bearer caller (200, identical list shape)", async () => {
    const env = await makeEnv();
    await createViaCanonical(env);
    const bearerRes = await app.request(
      "/v1/workspaces/acme/galleries",
      { headers: { Authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const sessionRes = await app.request(
      "/v1/workspaces/acme/galleries",
      { headers: { cookie: "session=x" } },
      env,
    );
    expect(bearerRes.status).toBe(200);
    expect(sessionRes.status).toBe(200);
    expect(await bearerRes.json()).toEqual(await sessionRes.json());
  });

  it("404s a signed-in caller who isn't a member of the workspace (uniform workspace_not_found)", async () => {
    const env = await makeEnv({ member: false });
    const res = await app.request(
      "/v1/workspaces/acme/galleries",
      { headers: { cookie: "session=x" } },
      env,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("workspace_not_found");
  });

  it("a session caller can also create/mutate galleries (member implies files:write, unlike the old session surface)", async () => {
    const env = await makeEnv();
    const res = await app.request(
      "/v1/workspaces/acme/galleries",
      {
        method: "POST",
        headers: { cookie: "session=x", "Content-Type": "application/json" },
        body: JSON.stringify({ title: "From session" }),
      },
      env,
    );
    expect(res.status).toBe(201);
  });
});

describe("old-path /me/workspaces/:name/galleries is NOT forwarded (issue #613 phase 2 divergence)", () => {
  it("keeps its own richer shape (itemCount/references) rather than the canonical bearer-shaped list", async () => {
    const env = await makeEnv();
    await createViaCanonical(env);

    const oldPath = await app.request(
      "/me/workspaces/acme/galleries",
      { headers: { cookie: "session=x" } },
      env,
    );
    expect(oldPath.status).toBe(200);
    const oldBody = (await oldPath.json()) as { galleries: Record<string, unknown>[] };
    expect(oldBody.galleries[0]).toHaveProperty("itemCount");
    expect(oldBody.galleries[0]).toHaveProperty("references");
    // No `nextCursor` on the old shape — confirms this is still the
    // pre-#613 handler, not a forward through the canonical route.
    expect(oldBody).not.toHaveProperty("nextCursor");

    const canonical = await app.request(
      "/v1/workspaces/acme/galleries",
      { headers: { cookie: "session=x" } },
      env,
    );
    const canonicalBody = (await canonical.json()) as { galleries: Record<string, unknown>[] };
    expect(canonicalBody.galleries[0]).not.toHaveProperty("itemCount");
    expect(canonicalBody).toHaveProperty("nextCursor");
  });
});
