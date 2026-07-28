import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { bumpDailyMetric } from "../adoption";
import { SqliteD1, database } from "../../test/helpers/sqlite-d1";
import { respondError } from "../error-response";
import { adminUi } from "./admin-ui";

// Both: buildOverview reads daily_metrics AND workspace_usage.
const MIGRATIONS = [
  "migrations/20260710140000_workspace_usage.sql",
  "migrations/20260728120000_daily_metrics.sql",
];
const ADMIN_USER = { id: "u-admin", email: "admin@b.com", name: "Admin", role: "admin" };
const NON_ADMIN_USER = { id: "u-plain", email: "plain@b.com", name: "Plain", role: "user" };

function stubAuth(user: typeof ADMIN_USER | null): Pick<Fetcher, "fetch"> {
  return {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const url = new URL(req.url);
      if (url.pathname === "/api/auth/get-session") {
        return new Response(JSON.stringify(user ? { session: {}, user } : null), { status: 200 });
      }
      if (url.pathname === "/internal/metrics") {
        return Response.json({
          users: [{ day: "2026-07-28", count: 3 }],
          orgs: [{ day: "2026-07-28", count: 1 }],
          totals: { users: 12, orgs: 4, admins: 1, banned: 0 },
        });
      }
      return new Response(null, { status: 404 });
    }) as Fetcher["fetch"],
  };
}

/** Minimal KV stub recording puts so cache behavior is assertable. */
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
      list: (async () => ({
        keys: [],
        list_complete: true,
        cacheStatus: null,
      })) as unknown as KVNamespace["list"],
    } as KVNamespace,
  };
}

function app() {
  return new Hono<{ Bindings: Env }>()
    .route("/admin-ui", adminUi)
    .onError((err, c) => respondError(c, err));
}

async function seededDb() {
  const sqlite = new SqliteD1(MIGRATIONS);
  const db = database(sqlite);
  const at = new Date();
  await bumpDailyMetric(db, { metric: "upload", workspace: "acme", bytes: 100 }, at);
  await bumpDailyMetric(db, { metric: "upload", workspace: "beta", bytes: 50 }, at);
  await bumpDailyMetric(db, { metric: "gallery_created", workspace: "acme" }, at);
  await db
    .prepare(
      `INSERT INTO workspace_usage (workspace, bytes, objects, uploads_in_period, period_start, updated_at)
       VALUES ('acme', 100, 1, 1, '2026-07', '2026-07-28T00:00:00Z'),
              ('beta', 50, 1, 1, '2026-07', '2026-07-28T00:00:00Z')`,
    )
    .run();
  return { sqlite, db };
}

describe("GET /admin-ui/metrics/overview", () => {
  it("401s with no session", async () => {
    const { sqlite, db } = await seededDb();
    try {
      const env = { AUTH: stubAuth(null), DB: db, REGISTRY: fakeKv().binding } as unknown as Env;
      const res = await app().request("/admin-ui/metrics/overview", {}, env);
      expect(res.status).toBe(401);
    } finally {
      sqlite.close();
    }
  });

  it("403s for a non-admin session", async () => {
    const { sqlite, db } = await seededDb();
    try {
      const env = {
        AUTH: stubAuth(NON_ADMIN_USER),
        DB: db,
        REGISTRY: fakeKv().binding,
      } as unknown as Env;
      const res = await app().request("/admin-ui/metrics/overview", {}, env);
      expect(res.status).toBe(403);
    } finally {
      sqlite.close();
    }
  });

  it("returns totals, series and the workspace table for an admin", async () => {
    const { sqlite, db } = await seededDb();
    try {
      const env = {
        AUTH: stubAuth(ADMIN_USER),
        DB: db,
        REGISTRY: fakeKv().binding,
      } as unknown as Env;
      const res = await app().request("/admin-ui/metrics/overview?days=30", {}, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        window: { days: number; since: string };
        totals: {
          users: number;
          orgs: number;
          workspaces: number;
          storedBytes: number;
          uploads: number;
          bytes: number;
          activeWorkspaces30d: number;
        };
        series: { uploads: unknown[]; users: unknown[] };
        features: Record<string, number>;
        workspaces: { workspace: string; uploads: number }[];
      };
      expect(body.window.days).toBe(30);
      expect(body.totals.users).toBe(12);
      expect(body.totals.orgs).toBe(4);
      expect(body.totals.workspaces).toBe(2);
      expect(body.totals.storedBytes).toBe(150);
      expect(body.totals.uploads).toBe(2);
      expect(body.totals.bytes).toBe(150);
      expect(body.totals.activeWorkspaces30d).toBe(2);
      expect(body.features.gallery_created).toBe(1);
      expect(body.workspaces.map((w) => w.workspace).sort()).toEqual(["acme", "beta"]);
    } finally {
      sqlite.close();
    }
  });

  it("serves the second request from cache without recomputing", async () => {
    const { sqlite, db } = await seededDb();
    try {
      const kv = fakeKv();
      const env = { AUTH: stubAuth(ADMIN_USER), DB: db, REGISTRY: kv.binding } as unknown as Env;
      await app().request("/admin-ui/metrics/overview?days=30", {}, env);
      expect(kv.puts).toBe(1);
      expect(kv.store.has("metrics:overview:v1:30")).toBe(true);
      const res = await app().request("/admin-ui/metrics/overview?days=30", {}, env);
      expect(res.status).toBe(200);
      expect(kv.puts).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it("bypasses the cache with ?fresh=1", async () => {
    const { sqlite, db } = await seededDb();
    try {
      const kv = fakeKv();
      const env = { AUTH: stubAuth(ADMIN_USER), DB: db, REGISTRY: kv.binding } as unknown as Env;
      await app().request("/admin-ui/metrics/overview?days=30", {}, env);
      await app().request("/admin-ui/metrics/overview?days=30&fresh=1", {}, env);
      expect(kv.puts).toBe(2);
    } finally {
      sqlite.close();
    }
  });

  it("still answers when the cache read throws", async () => {
    const { sqlite, db } = await seededDb();
    try {
      const broken = {
        get: (async () => {
          throw new Error("KV down");
        }) as unknown as KVNamespace["get"],
        put: (async () => {
          throw new Error("KV down");
        }) as unknown as KVNamespace["put"],
      } as KVNamespace;
      const env = { AUTH: stubAuth(ADMIN_USER), DB: db, REGISTRY: broken } as unknown as Env;
      const res = await app().request("/admin-ui/metrics/overview", {}, env);
      expect(res.status).toBe(200);
    } finally {
      sqlite.close();
    }
  });

  it("rejects an unsupported window", async () => {
    const { sqlite, db } = await seededDb();
    try {
      const env = {
        AUTH: stubAuth(ADMIN_USER),
        DB: db,
        REGISTRY: fakeKv().binding,
      } as unknown as Env;
      const res = await app().request("/admin-ui/metrics/overview?days=365", {}, env);
      expect(res.status).toBe(400);
    } finally {
      sqlite.close();
    }
  });
});
