import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";
import { facetKeys, facetValues } from "./file-metadata";

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
