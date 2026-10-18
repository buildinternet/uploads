import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { bumpDailyMetric } from "../adoption";
import { SqliteD1, database } from "../../test/helpers/sqlite-d1";
import type { ClassifierFlaggedPage, ClassifierOverview } from "../classifier-admin-wire";
import { respondError } from "../error-response";
import { adminUi } from "./admin-ui";

const MIGRATIONS = [
  "migrations/20260713210559_file_metadata.sql",
  "migrations/20260722180000_file_metadata_value_covering_idx.sql",
  "migrations/20260728120000_daily_metrics.sql",
];
const ADMIN_USER = { id: "u-admin", email: "admin@b.com", name: "Admin", role: "admin" };
const NON_ADMIN_USER = { id: "u-plain", email: "plain@b.com", name: "Plain", role: "user" };

function stubAuth(user: typeof ADMIN_USER | null): Pick<Fetcher, "fetch"> {
  return {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (new URL(req.url).pathname === "/api/auth/get-session") {
        return new Response(JSON.stringify(user ? { session: {}, user } : null), { status: 200 });
      }
      return new Response(null, { status: 404 });
    }) as Fetcher["fetch"],
  };
}

function fakeKv() {
  const store = new Map<string, string>();
  let puts = 0;
  return {
    store,
    get puts() {
      return puts;
    },
    binding: {
      get: (async (key: string) => store.get(key) ?? null) as unknown as KVNamespace["get"],
      put: (async (key: string, value: string) => {
        puts += 1;
        store.set(key, value);
      }) as unknown as KVNamespace["put"],
    } as KVNamespace,
  };
}

function app() {
  return new Hono<{ Bindings: Env }>()
    .route("/admin-ui", adminUi)
    .onError((err, c) => respondError(c, err));
}

type Db = ReturnType<typeof database>;
const NOW = new Date().toISOString();
const DAY_MS = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();

async function put(db: Db, workspace: string, key: string, meta: Record<string, string>, at = NOW) {
  for (const [k, v] of Object.entries(meta)) {
    await db
      .prepare(
        `INSERT INTO file_metadata (workspace, object_key, meta_key, meta_value, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(workspace, key, k, v, at)
      .run();
  }
}

async function seeded() {
  const sqlite = new SqliteD1(MIGRATIONS);
  const db = database(sqlite);
  // a.png: flagged rating (high) + clean content
  await put(db, "acme", "a.png", {
    "ai.classifier": "v6",
    "ai.kind": "screenshot",
    "ai.surface": "web",
    "ai.screen": "dashboard",
    "ai.rating": "explicit",
    "ai.rating.confidence": "high",
    "ai.content": "none",
    "ai.content.confidence": "high",
  });
  // b.png: flagged secret (low) and pii (medium), older
  await put(
    db,
    "acme",
    "b.png",
    {
      "ai.classifier": "v6",
      "ai.kind": "photo",
      "ai.secret": "api_key",
      "ai.secret.confidence": "low",
      "ai.pii": "email",
      "ai.pii.confidence": "medium",
    },
    ago(1),
  );
  // c.png: all clean
  await put(db, "beta", "c.png", {
    "ai.classifier": "v5",
    "ai.rating": "safe",
    "ai.rating.confidence": "high",
    "ai.content": "none",
    "ai.secret": "none",
    "ai.pii": "none",
  });
  // d.png: skipped, no safety keys
  await put(db, "beta", "d.png", { "ai.classifier": "skipped", "ai.skip": "too_small" }, ago(2));
  // e.png: failed
  await put(db, "beta", "e.png", { "ai.classifier": "failed", "ai.error": "timeout" }, ago(2));
  // f.png: flagged content, high, in beta, same timestamp as a.png tiebreak
  await put(db, "beta", "f.png", {
    "ai.classifier": "v6",
    "ai.content": "violence",
    "ai.content.confidence": "high",
  });
  await bumpDailyMetric(db, { metric: "upload", workspace: "acme", bytes: 1 }, new Date());
  await bumpDailyMetric(db, { metric: "upload", workspace: "beta", bytes: 1 }, new Date());
  return { sqlite, db };
}

function envFor(db: Db, user: typeof ADMIN_USER | null, kv = fakeKv()) {
  return {
    env: { AUTH: stubAuth(user), DB: db, REGISTRY: kv.binding } as unknown as Env,
    kv,
  };
}

async function withDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const { sqlite, db } = await seeded();
  try {
    return await fn(db);
  } finally {
    sqlite.close();
  }
}

describe("classifier admin auth and validation", () => {
  it("401s without a session and 403s for non-admins", async () => {
    await withDb(async (db) => {
      for (const path of ["/admin-ui/classifier/overview", "/admin-ui/classifier/flagged"]) {
        expect((await app().request(path, {}, envFor(db, null).env)).status).toBe(401);
        expect((await app().request(path, {}, envFor(db, NON_ADMIN_USER).env)).status).toBe(403);
      }
    });
  });

  it("rejects bad params", async () => {
    await withDb(async (db) => {
      const { env } = envFor(db, ADMIN_USER);
      for (const path of [
        "/admin-ui/classifier/overview?days=14",
        "/admin-ui/classifier/flagged?field=nope",
        "/admin-ui/classifier/flagged?confidence=low",
        "/admin-ui/classifier/flagged?workspace=Bad%20Name!",
        "/admin-ui/classifier/flagged?cursor=%25%25",
        "/admin-ui/classifier/flagged?limit=0",
        "/admin-ui/classifier/flagged?limit=201",
        "/admin-ui/classifier/flagged?limit=abc",
      ]) {
        expect((await app().request(path, {}, env)).status, path).toBe(400);
      }
    });
  });
});

describe("GET /admin-ui/classifier/overview", () => {
  it("counts versions, skips, failures, kinds and flags", async () => {
    await withDb(async (db) => {
      const { env } = envFor(db, ADMIN_USER);
      const res = await app().request("/admin-ui/classifier/overview?days=7", {}, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as ClassifierOverview;
      expect(body.days).toBe(7);
      expect(body.workspaces).toBe(2);
      expect(Object.fromEntries(body.versions.map((v) => [v.value, v.count]))).toEqual({
        v6: 3,
        v5: 1,
        skipped: 1,
        failed: 1,
      });
      expect(body.classified).toBe(4);
      expect(body.skipped).toBe(1);
      expect(body.failed).toBe(1);
      expect(body.skipReasons).toEqual([{ value: "too_small", count: 1 }]);
      expect(body.errorReasons).toEqual([{ value: "timeout", count: 1 }]);
      expect(body.kinds.map((k) => k.value).sort()).toEqual(["photo", "screenshot"]);
      expect(body.surfaces).toEqual([{ value: "web", count: 1 }]);
      expect(body.screens).toEqual([{ value: "dashboard", count: 1 }]);

      const rating = body.flags.find((f) => f.field === "rating")!;
      // safe is stored but not flagged.
      expect(rating.answered).toBe(2);
      expect(rating.flagged).toBe(1);
      expect(rating.values.map((v) => v.value).sort()).toEqual(["explicit", "safe"]);
      expect(rating.flaggedConfidence).toEqual({ high: 1, medium: 0, low: 0 });
      const content = body.flags.find((f) => f.field === "content")!;
      expect(content.answered).toBe(3);
      expect(content.flagged).toBe(1);
      expect(content.flaggedConfidence.high).toBe(1);
      const secret = body.flags.find((f) => f.field === "secret")!;
      expect(secret.flagged).toBe(1);
      expect(secret.flaggedConfidence).toEqual({ high: 0, medium: 0, low: 1 });
      expect(body.flags.map((f) => f.field)).toEqual(["rating", "content", "secret", "pii"]);
      // a.png, b.png (two flags, counted once) and f.png.
      expect(body.flaggedFiles).toBe(3);
      expect(body.windowUploads).toBe(2);
    });
  });

  it("fills the daily series for the window and splits outcomes", async () => {
    await withDb(async (db) => {
      const { env } = envFor(db, ADMIN_USER);
      const body = (await (
        await app().request("/admin-ui/classifier/overview?days=7", {}, env)
      ).json()) as ClassifierOverview;
      expect(body.daily).toHaveLength(7);
      const today = body.daily[6]!;
      expect(today).toMatchObject({ classified: 3, skipped: 0, failed: 0 });
      const twoAgo = body.daily[4]!;
      expect(twoAgo).toMatchObject({ classified: 0, skipped: 1, failed: 1 });
      expect(body.daily[0]).toMatchObject({ classified: 0, skipped: 0, failed: 0 });
    });
  });

  it("serves from the KV cache and fresh=1 bypasses it", async () => {
    await withDb(async (db) => {
      const { env, kv } = envFor(db, ADMIN_USER);
      await app().request("/admin-ui/classifier/overview?days=30", {}, env);
      expect(kv.puts).toBe(1);
      expect(kv.store.has("metrics:classifier:v1:30")).toBe(true);
      await put(db, "acme", "g.png", { "ai.classifier": "v6" });
      const cached = (await (
        await app().request("/admin-ui/classifier/overview?days=30", {}, env)
      ).json()) as ClassifierOverview;
      expect(cached.classified).toBe(4);
      expect(kv.puts).toBe(1);
      const fresh = (await (
        await app().request("/admin-ui/classifier/overview?days=30&fresh=1", {}, env)
      ).json()) as ClassifierOverview;
      expect(fresh.classified).toBe(5);
      expect(kv.puts).toBe(2);
    });
  });
});

describe("GET /admin-ui/classifier/flagged", () => {
  async function list(db: Db, qs = "") {
    const res = await app().request(
      `/admin-ui/classifier/flagged${qs}`,
      {},
      envFor(db, ADMIN_USER).env,
    );
    expect(res.status).toBe(200);
    return (await res.json()) as ClassifierFlaggedPage;
  }

  it("lists flagged files newest first, ties by workspace then key; clean and missing excluded", async () => {
    await withDb(async (db) => {
      const page = await list(db);
      expect(page.files.map((f) => `${f.workspace}/${f.key}`)).toEqual([
        "acme/a.png",
        "beta/f.png",
        "acme/b.png",
      ]);
      expect(page.nextCursor).toBeNull();
      const a = page.files[0]!;
      expect(a).toMatchObject({
        classifier: "v6",
        kind: "screenshot",
        surface: "web",
        screen: "dashboard",
      });
      expect(a.flags).toEqual([{ field: "rating", value: "explicit", confidence: "high" }]);
      // flags in rating, content, secret, pii order; only flagged fields.
      expect(page.files[2]!.flags).toEqual([
        { field: "secret", value: "api_key", confidence: "low" },
        { field: "pii", value: "email", confidence: "medium" },
      ]);
      expect(page.files[2]!.flaggedAt < page.files[0]!.flaggedAt).toBe(true);
    });
  });

  it("filters by field, confidence and workspace", async () => {
    await withDb(async (db) => {
      expect((await list(db, "?field=pii")).files.map((f) => f.key)).toEqual(["b.png"]);
      expect((await list(db, "?confidence=high")).files.map((f) => f.key)).toEqual([
        "a.png",
        "f.png",
      ]);
      expect((await list(db, "?field=secret&confidence=high")).files).toEqual([]);
      expect((await list(db, "?workspace=beta")).files.map((f) => f.key)).toEqual(["f.png"]);
    });
  });

  it("paginates with a cursor without gaps or repeats", async () => {
    await withDb(async (db) => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: ClassifierFlaggedPage = await list(
          db,
          `?limit=1${cursor ? `&cursor=${cursor}` : ""}`,
        );
        seen.push(...page.files.map((f) => `${f.workspace}/${f.key}`));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor && pages < 10);
      expect(pages).toBe(3);
      expect(seen).toEqual(["acme/a.png", "beta/f.png", "acme/b.png"]);
    });
  });

  it("hydrates more files than one bound-parameter chunk", async () => {
    await withDb(async (db) => {
      for (let i = 0; i < 120; i++) {
        await put(db, "bulk", `k${String(i).padStart(3, "0")}.png`, {
          "ai.classifier": "v6",
          "ai.pii": "email",
        });
      }
      const page = await list(db, "?workspace=bulk&limit=120");
      expect(page.files).toHaveLength(120);
      expect(page.files.every((f) => f.flags[0]?.field === "pii" && f.classifier === "v6")).toBe(
        true,
      );
    });
  });
});
