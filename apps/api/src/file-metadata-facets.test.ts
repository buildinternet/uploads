import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  facetKeys,
  facetValues,
  groupObjectsByPath,
  projectLabelFromMeta,
  BY_PATH_GROUP_LIMIT,
  BY_PATH_RECENT_LIMIT,
} from "./file-metadata";

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

function db(rows: Array<{ workspace: string; key: string; meta: Record<string, string> }>) {
  const database = new DatabaseSync(":memory:");
  database.exec(
    readFileSync(
      fileURLToPath(new NodeURL("../migrations/20260713210559_file_metadata.sql", import.meta.url)),
      "utf8",
    ),
  );
  const insert = database.prepare(
    "INSERT INTO file_metadata (workspace, object_key, meta_key, meta_value, updated_at) VALUES (?, ?, ?, ?, ?)",
  );
  for (const row of rows) {
    for (const [k, v] of Object.entries(row.meta)) {
      insert.run(row.workspace, row.key, k, v, "2026-07-25T00:00:00.000Z");
    }
  }
  return new SQLiteD1(database) as unknown as D1Database;
}

/** Like `db()` but with a per-row timestamp, for recency-ordered queries. */
function timedDb(
  rows: Array<{ workspace: string; key: string; meta: Record<string, string>; at: string }>,
) {
  const database = new DatabaseSync(":memory:");
  database.exec(
    readFileSync(
      fileURLToPath(new NodeURL("../migrations/20260713210559_file_metadata.sql", import.meta.url)),
      "utf8",
    ),
  );
  const insert = database.prepare(
    "INSERT INTO file_metadata (workspace, object_key, meta_key, meta_value, updated_at) VALUES (?, ?, ?, ?, ?)",
  );
  for (const row of rows) {
    for (const [k, v] of Object.entries(row.meta)) {
      insert.run(row.workspace, row.key, k, v, row.at);
    }
  }
  return new SQLiteD1(database) as unknown as D1Database;
}

describe("facetKeys", () => {
  it("returns each key with its file count and distinct-value count, most common first", async () => {
    const result = await facetKeys(
      db([
        { workspace: "acme", key: "a.png", meta: { "gh.repo": "o/r", app: "web" } },
        { workspace: "acme", key: "b.png", meta: { "gh.repo": "o/r", app: "api" } },
        { workspace: "acme", key: "c.png", meta: { "gh.repo": "o/other" } },
      ]),
      "acme",
    );
    expect(result.truncated).toBe(false);
    expect(result.keys).toEqual([
      { key: "gh.repo", count: 3, distinctValues: 2 },
      { key: "app", count: 2, distinctValues: 2 },
    ]);
  });

  it("flags truncation when more keys exist than the cap", async () => {
    const result = await facetKeys(
      db([
        {
          workspace: "acme",
          key: "a.png",
          meta: Object.fromEntries(Array.from({ length: 55 }, (_, i) => [`k${i}`, "v"])),
        },
      ]),
      "acme",
    );
    expect(result.keys).toHaveLength(50);
    expect(result.truncated).toBe(true);
  });

  it("excludes server-owned video.* keys", async () => {
    const result = await facetKeys(
      db([{ workspace: "acme", key: "v.mp4", meta: { "video.poster": "x", app: "web" } }]),
      "acme",
    );
    expect(result.keys.map((k) => k.key)).toEqual(["app"]);
  });

  it("does not leak another workspace's keys", async () => {
    const result = await facetKeys(
      db([
        { workspace: "acme", key: "a.png", meta: { app: "web" } },
        { workspace: "other", key: "b.png", meta: { secret: "yes" } },
      ]),
      "acme",
    );
    expect(result.keys.map((k) => k.key)).toEqual(["app"]);
  });
});

describe("facetValues", () => {
  it("returns each value with its count, most common first", async () => {
    const result = await facetValues(
      db([
        { workspace: "acme", key: "a.png", meta: { app: "web" } },
        { workspace: "acme", key: "b.png", meta: { app: "web" } },
        { workspace: "acme", key: "c.png", meta: { app: "api" } },
      ]),
      "acme",
      "app",
    );
    expect(result.truncated).toBe(false);
    expect(result.values).toEqual([
      { value: "web", count: 2 },
      { value: "api", count: 1 },
    ]);
  });

  it("flags truncation when more values exist than the cap", async () => {
    const rows = Array.from({ length: 55 }, (_, i) => ({
      workspace: "acme",
      key: `f${i}.png`,
      meta: { app: `v${i}` },
    }));
    const result = await facetValues(db(rows), "acme", "app");
    expect(result.values).toHaveLength(50);
    expect(result.truncated).toBe(true);
  });

  it("returns nothing for a server-owned key", async () => {
    const result = await facetValues(
      db([{ workspace: "acme", key: "v.mp4", meta: { "video.poster": "x" } }]),
      "acme",
      "video.poster",
    );
    expect(result.values).toEqual([]);
  });
});

describe("groupObjectsByPath", () => {
  const at = (i: number) => `2026-08-01T00:00:${String(i).padStart(2, "0")}.000Z`;

  it("groups keys by path value, most recently active group first", async () => {
    const result = await groupObjectsByPath(
      timedDb([
        { workspace: "acme", key: "a.png", meta: { path: "/settings" }, at: at(1) },
        { workspace: "acme", key: "b.png", meta: { path: "/home" }, at: at(2) },
        { workspace: "acme", key: "c.png", meta: { path: "/settings" }, at: at(3) },
      ]),
      "acme",
    );
    expect(result.truncated).toBe(false);
    expect(result.groups).toEqual([
      {
        project: "Other",
        path: "/settings",
        count: 2,
        lastUpdated: at(3),
        recent: ["c.png", "a.png"],
      },
      { project: "Other", path: "/home", count: 1, lastUpdated: at(2), recent: ["b.png"] },
    ]);
    expect(result.projects).toEqual([{ label: "Other", count: 3, lastUpdated: at(3) }]);
  });

  it("reads app metadata so local-origin shots group by app, not host (#692)", async () => {
    const result = await groupObjectsByPath(
      timedDb([
        {
          workspace: "acme",
          key: "a.png",
          meta: { path: "/x", url: "http://localhost:3000/x", app: "web" },
          at: at(1),
        },
        {
          workspace: "acme",
          key: "b.png",
          meta: { path: "/x", url: "http://localhost:3000/x" },
          at: at(2),
        },
      ]),
      "acme",
    );
    expect(result.groups.map((g) => g.project)).toEqual(["local dev", "web"]);
  });

  it("caps recent keys per group at BY_PATH_RECENT_LIMIT but counts all", async () => {
    const rows = Array.from({ length: BY_PATH_RECENT_LIMIT + 2 }, (_, i) => ({
      workspace: "acme",
      key: `shot-${i}.png`,
      meta: { path: "/home" },
      at: at(i),
    }));
    const result = await groupObjectsByPath(timedDb(rows), "acme");
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.count).toBe(BY_PATH_RECENT_LIMIT + 2);
    expect(result.groups[0]!.recent).toHaveLength(BY_PATH_RECENT_LIMIT);
    // Newest first — the two oldest fell off.
    expect(result.groups[0]!.recent[0]).toBe(`shot-${BY_PATH_RECENT_LIMIT + 1}.png`);
    expect(result.groups[0]!.recent).not.toContain("shot-0.png");
    expect(result.groups[0]!.recent).not.toContain("shot-1.png");
  });

  it("caps groups at BY_PATH_GROUP_LIMIT and reports truncation", async () => {
    const rows = Array.from({ length: BY_PATH_GROUP_LIMIT + 1 }, (_, i) => ({
      workspace: "acme",
      key: `shot-${i}.png`,
      meta: { path: `/page-${i}` },
      at: at(i),
    }));
    const result = await groupObjectsByPath(timedDb(rows), "acme");
    expect(result.groups).toHaveLength(BY_PATH_GROUP_LIMIT);
    expect(result.truncated).toBe(true);
    // Group cap keeps the most recently active groups, drops the oldest.
    expect(result.groups.map((g) => g.path)).not.toContain("/page-0");
  });

  it("ignores other workspaces and other meta keys", async () => {
    const result = await groupObjectsByPath(
      timedDb([
        { workspace: "acme", key: "a.png", meta: { path: "/home", state: "after" }, at: at(1) },
        { workspace: "other", key: "b.png", meta: { path: "/home" }, at: at(2) },
        { workspace: "acme", key: "c.png", meta: { app: "web" }, at: at(3) },
      ]),
      "acme",
    );
    expect(result.groups).toEqual([
      { project: "Other", path: "/home", count: 1, lastUpdated: at(1), recent: ["a.png"] },
    ]);
  });

  it("returns empty groups for a workspace with no path metadata", async () => {
    const result = await groupObjectsByPath(timedDb([]), "acme");
    expect(result).toEqual({ groups: [], projects: [], truncated: false });
  });

  it("splits the same path across projects and summarizes projects", async () => {
    const result = await groupObjectsByPath(
      db([
        { workspace: "acme", key: "a.png", meta: { path: "/admin", repo: "acme/web" } },
        { workspace: "acme", key: "b.png", meta: { path: "/admin", "gh.repo": "acme/api" } },
        { workspace: "acme", key: "c.png", meta: { path: "/admin", url: "https://x.dev/admin" } },
        { workspace: "acme", key: "d.png", meta: { path: "/other", repo: "acme/web" } },
      ]),
      "acme",
    );
    expect(result.groups.map((g) => [g.project, g.path, g.count])).toEqual(
      expect.arrayContaining([
        ["acme/web", "/admin", 1],
        ["acme/api", "/admin", 1],
        ["x.dev", "/admin", 1],
        ["acme/web", "/other", 1],
      ]),
    );
    expect(result.groups).toHaveLength(4);
    const labels = result.projects.map((p) => p.label).sort();
    expect(labels).toEqual(["acme/api", "acme/web", "x.dev"]);
    expect(result.projects.find((p) => p.label === "acme/web")?.count).toBe(2);
  });

  it("prefers repo over gh.repo over url when a file has several", async () => {
    const result = await groupObjectsByPath(
      db([
        {
          workspace: "acme",
          key: "a.png",
          meta: { path: "/p", repo: "acme/web", "gh.repo": "acme/api", url: "https://x.dev/p" },
        },
      ]),
      "acme",
    );
    expect(result.groups[0]).toMatchObject({ project: "acme/web", path: "/p" });
  });
});

describe("projectLabelFromMeta", () => {
  it("prefers repo over gh.repo over url origin", () => {
    expect(
      projectLabelFromMeta({ repo: "acme/web", ghRepo: "acme/other", url: "https://x.dev/p" }),
    ).toBe("acme/web");
    expect(projectLabelFromMeta({ ghRepo: "acme/other", url: "https://x.dev/p" })).toBe(
      "acme/other",
    );
  });
  it("falls back to the url host, keeping the port", () => {
    expect(projectLabelFromMeta({ url: "https://staging.x.dev:8443/p" })).toBe(
      "staging.x.dev:8443",
    );
  });
  it("labels context-less local origins 'local dev' instead of the raw host (#692)", () => {
    expect(projectLabelFromMeta({ url: "http://localhost:3000/admin" })).toBe("local dev");
    expect(projectLabelFromMeta({ url: "https://uploads.localhost/settings" })).toBe("local dev");
    expect(projectLabelFromMeta({ url: "http://127.0.0.1:8788/x" })).toBe("local dev");
    expect(projectLabelFromMeta({ url: "http://0.0.0.0:4321/" })).toBe("local dev");
    expect(projectLabelFromMeta({ url: "http://[::1]:3000/" })).toBe("local dev");
  });
  it("app metadata names local-origin and url-less groups, but never outranks a real host", () => {
    expect(projectLabelFromMeta({ url: "http://localhost:3000/admin", app: "web" })).toBe("web");
    expect(projectLabelFromMeta({ app: "ios" })).toBe("ios");
    expect(projectLabelFromMeta({ url: "https://x.dev/p", app: "web" })).toBe("x.dev");
    expect(projectLabelFromMeta({ repo: "acme/web", app: "ios" })).toBe("acme/web");
  });
  it("returns Other for missing or unparseable url", () => {
    expect(projectLabelFromMeta({})).toBe("Other");
    expect(projectLabelFromMeta({ url: "not a url" })).toBe("Other");
    expect(projectLabelFromMeta({ repo: null, ghRepo: null, url: null })).toBe("Other");
  });
});
