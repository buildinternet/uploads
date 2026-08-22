import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { fakeRegistry } from "../../test/fake-kv";
import { FakeR2Bucket } from "../../test/fake-r2";
import { SqliteD1, database } from "../../test/helpers/sqlite-d1";
import { respondError } from "../error-response";
import { createGallery } from "../galleries";
import { admin } from "./admin";

const ADMIN_TOKEN = "test-admin-token";
const MIGRATIONS = [
  "migrations/20260711180000_galleries.sql",
  "migrations/20260713210559_file_metadata.sql",
  "migrations/20260710140000_workspace_usage.sql",
  "migrations/20260822120100_workspace_usage_shared_subset.sql",
  "migrations/20260730170533_delete_usage_claims.sql",
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

function appWith(opts: {
  kvRecords?: Record<string, unknown>;
  onDeleteOrg?: (slug: string) => void;
  bucket?: FakeR2Bucket;
  db?: SqliteD1;
}) {
  const { kvRecords = {}, onDeleteOrg, bucket = new FakeR2Bucket(), db } = opts;
  const auth = stubAuth((req) => {
    const url = new URL(req.url);
    if (req.method === "DELETE" && url.pathname.startsWith("/internal/orgs/")) {
      onDeleteOrg?.(decodeURIComponent(url.pathname.slice("/internal/orgs/".length)));
      return new Response(null, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
  const registry = fakeRegistry(kvRecords);
  const app = new Hono<{ Bindings: Env }>()
    .route("/admin", admin)
    .onError((err, c) => respondError(c, err));
  const env = {
    ADMIN_TOKEN,
    AUTH: auth,
    REGISTRY: registry,
    UPLOADS_DEFAULT: bucket,
    DB: db ? database(db) : undefined,
  } as unknown as Env;
  return { app, env, registry, bucket };
}

function deleteRequest(
  name: string,
  opts?: { force?: boolean; hard?: boolean; purgeObjects?: boolean },
) {
  const url = new URL(`https://api.uploads.sh/admin/workspaces/${name}`);
  if (opts?.force) url.searchParams.set("force", "1");
  if (opts?.hard) url.searchParams.set("hard", "1");
  if (opts?.purgeObjects) url.searchParams.set("purgeObjects", "1");
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

function getRequest(name: string) {
  return new Request(`https://api.uploads.sh/admin/workspaces/${name}`, {
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
      expect(registry.store.has("ws:acme")).toBe(false);
    } finally {
      sqlite.close();
    }
  });

  describe("dedicated-bucket guard on ?hard=1 (#583)", () => {
    const UNPREFIXED_RECORD = { ...RECORD, prefix: undefined };

    it("tears down platform state but skips R2 objects for an unprefixed record", async () => {
      const bucket = new FakeR2Bucket();
      await bucket.put("one.png", new Uint8Array([1, 2, 3]));
      const sqlite = new SqliteD1(MIGRATIONS);
      try {
        await createGallery(database(sqlite), { workspace: "acme", title: "Gallery" });

        let deletedOrgSlug: string | undefined;
        const {
          app,
          env,
          registry,
          bucket: envBucket,
        } = appWith({
          kvRecords: { "ws:acme": UNPREFIXED_RECORD },
          bucket,
          db: sqlite,
          onDeleteOrg: (slug) => {
            deletedOrgSlug = slug;
          },
        });

        const res = await app.request(deleteRequest("acme", { force: true, hard: true }), {}, env);
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          objectsDeleted: number;
          galleriesDeleted: number;
          objectsSkipped?: string;
        };
        expect(body.objectsDeleted).toBe(0);
        expect(body.objectsSkipped).toBe("dedicated-bucket");

        // The skip means no bucket scan at all, not just no deletes — a
        // listAll() over a large remote BYO bucket is itself the hazard.
        expect(envBucket.listCalls).toBe(0);
        // Object left in place...
        expect(envBucket.store.has("one.png")).toBe(true);
        // ...while platform state is still torn down: galleries, org, and
        // the KV record (slug freed).
        expect(body.galleriesDeleted).toBe(1);
        expect(deletedOrgSlug).toBe("acme");
        expect(registry.store.has("ws:acme")).toBe(false);
      } finally {
        sqlite.close();
      }
    });

    it("purges objects on an unprefixed record when ?purgeObjects=1 is passed", async () => {
      const bucket = new FakeR2Bucket();
      await bucket.put("one.png", new Uint8Array([1, 2, 3]));
      const sqlite = new SqliteD1(MIGRATIONS);
      try {
        const {
          app,
          env,
          bucket: envBucket,
        } = appWith({
          kvRecords: { "ws:acme": UNPREFIXED_RECORD },
          bucket,
          db: sqlite,
        });

        const res = await app.request(
          deleteRequest("acme", { force: true, hard: true, purgeObjects: true }),
          {},
          env,
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { objectsDeleted: number; objectsSkipped?: string };
        expect(body.objectsDeleted).toBe(1);
        expect(body.objectsSkipped).toBeUndefined();
        expect(envBucket.store.has("one.png")).toBe(false);
      } finally {
        sqlite.close();
      }
    });

    it("still fully purges a prefixed shared-bucket record without purgeObjects", async () => {
      // Regression guard: the flag must not be required for the common case.
      const bucket = new FakeR2Bucket();
      await bucket.put("acme/one.png", new Uint8Array([1, 2, 3]));
      const sqlite = new SqliteD1(MIGRATIONS);
      try {
        const {
          app,
          env,
          bucket: envBucket,
        } = appWith({
          kvRecords: { "ws:acme": RECORD },
          bucket,
          db: sqlite,
        });

        const res = await app.request(deleteRequest("acme", { force: true, hard: true }), {}, env);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { objectsDeleted: number; objectsSkipped?: string };
        expect(body.objectsDeleted).toBe(1);
        expect(body.objectsSkipped).toBeUndefined();
        expect(envBucket.store.has("acme/one.png")).toBe(false);
      } finally {
        sqlite.close();
      }
    });
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

      const stored = registry.record<{ deletedAt?: string; purgeAt?: string }>("acme")!;
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

      const stored = registry.record<{ deletedAt?: string; purgeAt?: string }>("acme")!;
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

describe("GET /admin/workspaces/:name", () => {
  it("401s without a valid admin token", async () => {
    const { app, env } = appWith({ kvRecords: { "ws:acme": RECORD } });
    const res = await app.request(
      new Request("https://api.uploads.sh/admin/workspaces/acme"),
      {},
      env,
    );
    expect(res.status).toBe(401);
  });

  it("404s workspace_not_found for an unknown workspace", async () => {
    const { app, env } = appWith({});
    const res = await app.request(getRequest("acme"), {}, env);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("workspace_not_found");
  });

  it("400s an invalid slug rather than looking it up", async () => {
    const { app, env } = appWith({});
    const res = await app.request(getRequest("Not_A_Slug"), {}, env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_workspace");
  });

  it("returns the storage placement and defaults for a live workspace", async () => {
    const { app, env } = appWith({ kvRecords: { "ws:acme": RECORD } });
    const res = await app.request(getRequest("acme"), {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      name: "acme",
      provider: "r2",
      bucket: "shared",
      binding: "UPLOADS_DEFAULT",
      prefix: "acme/",
      publicBaseUrl: "https://storage.uploads.sh",
      deletedAt: null,
      purgeAt: null,
      selfServe: false,
      plan: null,
      hasHttpCredentials: false,
    });
    // Unset key policy reads as the permissive default, not as absent.
    expect(body.keyPolicy).toMatchObject({ autoPrefixBareKeys: true, allowedKeyPrefixes: null });
  });

  it("reports a soft-deleted workspace with its grace window instead of 404ing", async () => {
    const { app, env } = appWith({ kvRecords: { "ws:acme": RECORD } });
    await app.request(deleteRequest("acme"), {}, env);

    const res = await app.request(getRequest("acme"), {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deletedAt: string | null; purgeAt: string | null };
    // The whole point of the route: an operator can see the record is inside
    // its grace window and therefore still restorable.
    expect(typeof body.deletedAt).toBe("string");
    expect(typeof body.purgeAt).toBe("string");
  });

  it("never exposes credentials or token hashes", async () => {
    const { app, env } = appWith({
      kvRecords: {
        "ws:acme": {
          ...RECORD,
          accountId: "acct-1",
          accessKeyId: "AKIAEXAMPLE",
          secretAccessKey: "super-secret",
          tokens: [{ hash: "deadbeefcafe", label: "ci", createdAt: "2026-01-01T00:00:00.000Z" }],
        },
      },
    });
    const res = await app.request(getRequest("acme"), {}, env);
    expect(res.status).toBe(200);
    const raw = await res.text();
    for (const secret of ["super-secret", "AKIAEXAMPLE", "deadbeefcafe"]) {
      expect(raw).not.toContain(secret);
    }
    const body = JSON.parse(raw) as {
      hasHttpCredentials: boolean;
      tokens: Array<{ label: string | null; createdAt: string }>;
    };
    expect(body.hasHttpCredentials).toBe(true);
    expect(body.tokens).toEqual([{ label: "ci", createdAt: "2026-01-01T00:00:00.000Z" }]);
  });

  it("surfaces a legacy tokenHash record as one unnamed token", async () => {
    const { app, env } = appWith({
      kvRecords: { "ws:acme": { ...RECORD, tokenHash: "legacyhash" } },
    });
    const res = await app.request(getRequest("acme"), {}, env);
    const raw = await res.text();
    expect(raw).not.toContain("legacyhash");
    const body = JSON.parse(raw) as { tokens: Array<{ label: string | null }> };
    expect(body.tokens).toHaveLength(1);
    expect(body.tokens[0]?.label).toBeNull();
  });
});
