import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { FakeR2Bucket } from "../../test/fake-r2";
import { SqliteD1, database } from "../../test/helpers/sqlite-d1";
import { respondError } from "../error-response";
import { createGallery } from "../galleries";
import { admin } from "./admin";

const ADMIN_TOKEN = "test-admin-token";
const MIGRATIONS = [
  "migrations/20260711180000_galleries.sql",
  "migrations/20260713210559_file_metadata.sql",
];

beforeAll(() => {
  if (typeof crypto.subtle.timingSafeEqual !== "function") {
    (
      crypto.subtle as unknown as { timingSafeEqual: (a: Uint8Array, b: Uint8Array) => boolean }
    ).timingSafeEqual = (a: Uint8Array, b: Uint8Array) =>
      a.length === b.length && a.every((byte, i) => byte === b[i]);
  }
});

function stubAuth(handler: (req: Request) => Response | Promise<Response>): Pick<Fetcher, "fetch"> {
  return {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      return handler(req);
    }) as Fetcher["fetch"],
  };
}

const RECORD = {
  provider: "r2",
  bucket: "shared",
  binding: "UPLOADS_DEFAULT",
  prefix: "acme/",
  publicBaseUrl: "https://storage.uploads.sh",
};

function fakeKv(records: Record<string, unknown>) {
  const store = new Map(Object.entries(records));
  return {
    get: (async (key: string) => store.get(key) ?? null) as unknown as KVNamespace["get"],
    put: (async (key: string, value: string) => {
      store.set(key, JSON.parse(value));
    }) as unknown as KVNamespace["put"],
    delete: (async (key: string) => {
      store.delete(key);
    }) as unknown as KVNamespace["delete"],
    __store: store,
  };
}

function appWith(opts: {
  kvRecords?: Record<string, unknown>;
  onDeleteOrg?: (slug: string) => void;
  bucket?: FakeR2Bucket;
  db?: SqliteD1;
  defaultWorkspace?: string;
}) {
  const { kvRecords = {}, onDeleteOrg, bucket = new FakeR2Bucket(), db, defaultWorkspace } = opts;
  const auth = stubAuth((req) => {
    const url = new URL(req.url);
    if (req.method === "DELETE" && url.pathname.startsWith("/internal/orgs/")) {
      onDeleteOrg?.(decodeURIComponent(url.pathname.slice("/internal/orgs/".length)));
      return new Response(null, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
  const registry = fakeKv(kvRecords);
  const app = new Hono<{ Bindings: Env }>()
    .route("/admin", admin)
    .onError((err, c) => respondError(c, err));
  const env = {
    ADMIN_TOKEN,
    AUTH: auth,
    REGISTRY: registry,
    UPLOADS_DEFAULT: bucket,
    DB: db ? database(db) : undefined,
    ...(defaultWorkspace ? { DEFAULT_WORKSPACE: defaultWorkspace } : {}),
  } as unknown as Env;
  return { app, env, registry, bucket };
}

function deleteRequest(name: string, opts?: { force?: boolean; hard?: boolean }) {
  const url = new URL(`https://api.uploads.sh/admin/workspaces/${name}`);
  if (opts?.force) url.searchParams.set("force", "1");
  if (opts?.hard) url.searchParams.set("hard", "1");
  return new Request(url, {
    method: "DELETE",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
}

function restoreRequest(name: string) {
  return new Request(`https://api.uploads.sh/admin/workspaces/${name}/restore`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
}

describe("DELETE /admin/workspaces/:name", () => {
  it("401s without a valid admin token", async () => {
    const { app, env } = appWith({});
    const req = new Request("https://api.uploads.sh/admin/workspaces/acme", { method: "DELETE" });
    const res = await app.request(req, {}, env);
    expect(res.status).toBe(401);
  });

  it("404s for an unknown workspace", async () => {
    const { app, env } = appWith({});
    const res = await app.request(deleteRequest("acme"), {}, env);
    expect(res.status).toBe(404);
  });

  it("refuses to delete the communal/protected workspace", async () => {
    const { app, env } = appWith({
      kvRecords: { "ws:default": RECORD },
      defaultWorkspace: "default",
    });
    const res = await app.request(deleteRequest("default"), {}, env);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("protected_workspace");
  });

  it("409s a non-empty workspace on ?hard=1 without ?force=1, reporting the object count", async () => {
    const bucket = new FakeR2Bucket();
    await bucket.put("acme/f/one.png", new Uint8Array([1, 2, 3]));
    const { app, env } = appWith({ kvRecords: { "ws:acme": RECORD }, bucket });
    const res = await app.request(deleteRequest("acme", { hard: true }), {}, env);
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; details?: { objectCount?: number } };
    };
    expect(body.error.code).toBe("workspace_not_empty");
    expect(body.error.details?.objectCount).toBe(1);
    // Nothing was touched.
    expect(bucket.store.has("acme/f/one.png")).toBe(true);
  });

  it("refuses to delete the communal/protected workspace on ?hard=1 too", async () => {
    const { app, env } = appWith({
      kvRecords: { "ws:default": RECORD },
      defaultWorkspace: "default",
    });
    const res = await app.request(deleteRequest("default", { hard: true }), {}, env);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("protected_workspace");
  });

  it("cascades a forced hard delete: R2 objects, D1 rows, auth org, then the KV record (slug freed)", async () => {
    const bucket = new FakeR2Bucket();
    await bucket.put("acme/f/one.png", new Uint8Array([1, 2, 3]));
    await bucket.put("acme/f/two.png", new Uint8Array([4, 5, 6, 7]));
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      await createGallery(database(sqlite), { workspace: "acme", title: "Gallery" });
      await createGallery(database(sqlite), { workspace: "beta", title: "Other" });

      let deletedOrgSlug: string | undefined;
      const {
        app,
        env,
        registry,
        bucket: envBucket,
      } = appWith({
        kvRecords: { "ws:acme": RECORD },
        bucket,
        db: sqlite,
        onDeleteOrg: (slug) => {
          deletedOrgSlug = slug;
        },
      });

      const res = await app.request(deleteRequest("acme", { force: true, hard: true }), {}, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        workspace: string;
        mode: string;
        deleted: boolean;
        forced: boolean;
        objectsDeleted: number;
        galleriesDeleted: number;
      };
      expect(body).toMatchObject({
        ok: true,
        workspace: "acme",
        mode: "hard",
        deleted: true,
        forced: true,
        objectsDeleted: 2,
        galleriesDeleted: 1,
      });

      // R2 objects gone.
      expect(envBucket.store.size).toBe(0);
      // Galleries gone for acme, untouched for beta.
      expect(
        sqlite.db.prepare("SELECT COUNT(*) AS count FROM galleries WHERE workspace = 'acme'").get(),
      ).toMatchObject({ count: 0 });
      expect(
        sqlite.db.prepare("SELECT COUNT(*) AS count FROM galleries WHERE workspace = 'beta'").get(),
      ).toMatchObject({ count: 1 });
      // Auth-side org delete was invoked for the right slug.
      expect(deletedOrgSlug).toBe("acme");
      // KV record removed outright — the slug is freed.
      expect(registry.__store.has("ws:acme")).toBe(false);
    } finally {
      sqlite.close();
    }
  });

  describe("soft delete (default)", () => {
    it("sets deletedAt/purgeAt, leaves data untouched, R2 intact", async () => {
      const bucket = new FakeR2Bucket();
      await bucket.put("acme/f/one.png", new Uint8Array([1, 2, 3]));
      const { app, env, registry } = appWith({ kvRecords: { "ws:acme": RECORD }, bucket });

      const res = await app.request(deleteRequest("acme"), {}, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        mode: string;
        deletedAt: string;
        purgeAt: string;
      };
      expect(body.ok).toBe(true);
      expect(body.mode).toBe("soft");
      expect(new Date(body.purgeAt).getTime() - new Date(body.deletedAt).getTime()).toBe(
        14 * 24 * 60 * 60 * 1000,
      );

      const stored = registry.__store.get("ws:acme") as { deletedAt?: string; purgeAt?: string };
      expect(stored.deletedAt).toBe(body.deletedAt);
      expect(stored.purgeAt).toBe(body.purgeAt);
      // Data untouched.
      expect(bucket.store.has("acme/f/one.png")).toBe(true);
    });

    it("a second delete 409s already_deleted with the existing purgeAt", async () => {
      const { app, env } = appWith({ kvRecords: { "ws:acme": RECORD } });
      const first = await app.request(deleteRequest("acme"), {}, env);
      const firstBody = (await first.json()) as { purgeAt: string };

      const second = await app.request(deleteRequest("acme"), {}, env);
      expect(second.status).toBe(409);
      const body = (await second.json()) as {
        error: { code: string; details?: { purgeAt?: string } };
      };
      expect(body.error.code).toBe("already_deleted");
      expect(body.error.details?.purgeAt).toBe(firstBody.purgeAt);
    });
  });

  describe("POST /admin/workspaces/:name/restore", () => {
    it("404s for an unknown workspace", async () => {
      const { app, env } = appWith({});
      const res = await app.request(restoreRequest("acme"), {}, env);
      expect(res.status).toBe(404);
    });

    it("409s not_deleted for a workspace that isn't soft-deleted", async () => {
      const { app, env } = appWith({ kvRecords: { "ws:acme": RECORD } });
      const res = await app.request(restoreRequest("acme"), {}, env);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("not_deleted");
    });

    it("restores within the grace window, clearing deletedAt/purgeAt", async () => {
      const { app, env, registry } = appWith({ kvRecords: { "ws:acme": RECORD } });
      await app.request(deleteRequest("acme"), {}, env);

      const res = await app.request(restoreRequest("acme"), {}, env);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, workspace: "acme" });

      const stored = registry.__store.get("ws:acme") as { deletedAt?: string; purgeAt?: string };
      expect(stored.deletedAt).toBeUndefined();
      expect(stored.purgeAt).toBeUndefined();
    });

    it("410s grace_expired once purgeAt has passed", async () => {
      const expired = {
        ...RECORD,
        deletedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
        purgeAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString(),
      };
      const { app, env } = appWith({ kvRecords: { "ws:acme": expired } });
      const res = await app.request(restoreRequest("acme"), {}, env);
      expect(res.status).toBe(410);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("grace_expired");
    });
  });
});
