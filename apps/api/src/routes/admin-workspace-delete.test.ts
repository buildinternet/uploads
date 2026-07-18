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

function deleteRequest(name: string, opts?: { force?: boolean }) {
  const url = new URL(`https://api.uploads.sh/admin/workspaces/${name}`);
  if (opts?.force) url.searchParams.set("force", "1");
  return new Request(url, {
    method: "DELETE",
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

  it("409s a non-empty workspace without ?force=1, reporting the object count", async () => {
    const bucket = new FakeR2Bucket();
    await bucket.put("acme/f/one.png", new Uint8Array([1, 2, 3]));
    const { app, env } = appWith({ kvRecords: { "ws:acme": RECORD }, bucket });
    const res = await app.request(deleteRequest("acme"), {}, env);
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; details?: { objectCount?: number } };
    };
    expect(body.error.code).toBe("workspace_not_empty");
    expect(body.error.details?.objectCount).toBe(1);
    // Nothing was touched.
    expect(bucket.store.has("acme/f/one.png")).toBe(true);
  });

  it("cascades a forced delete: R2 objects, D1 rows, auth org, then the KV record", async () => {
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

      const res = await app.request(deleteRequest("acme", { force: true }), {}, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        workspace: string;
        deleted: boolean;
        forced: boolean;
        objectsDeleted: number;
        galleriesDeleted: number;
      };
      expect(body).toMatchObject({
        workspace: "acme",
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
      // KV record removed last.
      expect(registry.__store.has("ws:acme")).toBe(false);
    } finally {
      sqlite.close();
    }
  });
});
