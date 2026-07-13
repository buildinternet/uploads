/// <reference types="node" />

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { AppError } from "@uploads/errors";
import { describe, expect, it } from "vitest";
import {
  META_MAX_KEYS,
  deleteFileMetadata,
  findObjectsByMetadata,
  getFileMetadata,
  setFileMetadata,
} from "../src/file-metadata";

type SqliteValue = string | number | bigint | null | Uint8Array;

class SqliteStatement {
  private values: SqliteValue[] = [];

  constructor(
    readonly owner: SqliteD1,
    readonly sql: string,
  ) {}

  bind(...values: unknown[]) {
    this.values = values as SqliteValue[];
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.owner.db.prepare(this.sql).get(...this.values) as T | undefined) ?? null;
  }

  async all<T>(): Promise<D1Result<T>> {
    return {
      success: true,
      results: this.owner.db.prepare(this.sql).all(...this.values) as T[],
      meta: {},
    } as D1Result<T>;
  }

  async run(): Promise<D1Result> {
    return this.runSync() as unknown as D1Result;
  }

  runSync() {
    const result = this.owner.db.prepare(this.sql).run(...this.values);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    };
  }
}

class SqliteD1 {
  readonly db = new DatabaseSync(":memory:");

  constructor() {
    this.db.exec(readFileSync("migrations/20260713210559_file_metadata.sql", "utf8"));
  }

  prepare(sql: string) {
    return new SqliteStatement(this, sql);
  }

  async batch(statements: SqliteStatement[]): Promise<D1Result[]> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.runSync() as unknown as D1Result);
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.db.close();
  }
}

function database(sqlite: SqliteD1): D1Database {
  return sqlite as unknown as D1Database;
}

describe("file metadata persistence against SQLite", () => {
  it("returns an empty map for an object with no metadata", async () => {
    const sqlite = new SqliteD1();
    try {
      await expect(getFileMetadata(database(sqlite), "alpha", "f/one.png")).resolves.toEqual({});
    } finally {
      sqlite.close();
    }
  });

  it("sets, reads, and scopes metadata by workspace and object key", async () => {
    const sqlite = new SqliteD1();
    try {
      const result = await setFileMetadata(database(sqlite), "alpha", "f/one.png", {
        app: "screenshots",
        "gh.repo": "buildinternet/uploads",
      });
      expect(result).toEqual({ app: "screenshots", "gh.repo": "buildinternet/uploads" });

      await expect(getFileMetadata(database(sqlite), "alpha", "f/one.png")).resolves.toEqual({
        app: "screenshots",
        "gh.repo": "buildinternet/uploads",
      });
      // Different workspace / different key must not see it.
      await expect(getFileMetadata(database(sqlite), "beta", "f/one.png")).resolves.toEqual({});
      await expect(getFileMetadata(database(sqlite), "alpha", "f/two.png")).resolves.toEqual({});
    } finally {
      sqlite.close();
    }
  });

  it("merges set and remove in the same call, upserting and deleting keys", async () => {
    const sqlite = new SqliteD1();
    try {
      await setFileMetadata(database(sqlite), "alpha", "f/one.png", {
        app: "screenshots",
        page: "/checkout",
        device: "iphone",
      });

      const merged = await setFileMetadata(
        database(sqlite),
        "alpha",
        "f/one.png",
        { page: "/cart", resolution: "1170x2532" },
        ["device"],
      );

      expect(merged).toEqual({
        app: "screenshots",
        page: "/cart",
        resolution: "1170x2532",
      });
      await expect(getFileMetadata(database(sqlite), "alpha", "f/one.png")).resolves.toEqual(
        merged,
      );
    } finally {
      sqlite.close();
    }
  });

  it("rejects a merge that would push the post-merge file over the key cap", async () => {
    const sqlite = new SqliteD1();
    try {
      const initial: Record<string, string> = {};
      for (let i = 0; i < META_MAX_KEYS; i++) initial[`k${i}`] = "v";
      await setFileMetadata(database(sqlite), "alpha", "f/one.png", initial);

      await expect(
        setFileMetadata(database(sqlite), "alpha", "f/one.png", { extra: "v" }),
      ).rejects.toBeInstanceOf(AppError);

      // Rejected merge must not have partially applied.
      await expect(getFileMetadata(database(sqlite), "alpha", "f/one.png")).resolves.toEqual(
        initial,
      );
    } finally {
      sqlite.close();
    }
  });

  it("allows a merge at the cap when it simultaneously removes a key", async () => {
    const sqlite = new SqliteD1();
    try {
      const initial: Record<string, string> = {};
      for (let i = 0; i < META_MAX_KEYS; i++) initial[`k${i}`] = "v";
      await setFileMetadata(database(sqlite), "alpha", "f/one.png", initial);

      const result = await setFileMetadata(database(sqlite), "alpha", "f/one.png", { extra: "v" }, [
        "k0",
      ]);
      expect(Object.keys(result)).toHaveLength(META_MAX_KEYS);
      expect(result.extra).toBe("v");
      expect(result.k0).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });

  it("deletes all metadata for an object", async () => {
    const sqlite = new SqliteD1();
    try {
      await setFileMetadata(database(sqlite), "alpha", "f/one.png", { app: "screenshots" });
      await deleteFileMetadata(database(sqlite), "alpha", "f/one.png");
      await expect(getFileMetadata(database(sqlite), "alpha", "f/one.png")).resolves.toEqual({});
    } finally {
      sqlite.close();
    }
  });

  it("finds only objects matching ALL AND-ed filters, scoped by workspace", async () => {
    const sqlite = new SqliteD1();
    try {
      await setFileMetadata(database(sqlite), "alpha", "f/one.png", {
        app: "screenshots",
        page: "/checkout",
      });
      await setFileMetadata(database(sqlite), "alpha", "f/two.png", {
        app: "screenshots",
        page: "/cart",
      });
      await setFileMetadata(database(sqlite), "alpha", "f/three.png", {
        app: "other",
        page: "/checkout",
      });
      await setFileMetadata(database(sqlite), "beta", "f/one.png", {
        app: "screenshots",
        page: "/checkout",
      });

      const matches = await findObjectsByMetadata(database(sqlite), "alpha", {
        app: "screenshots",
        page: "/checkout",
      });
      expect(matches).toEqual([
        { key: "f/one.png", metadata: { app: "screenshots", page: "/checkout" } },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("combines a key prefix filter with metadata AND-filters", async () => {
    const sqlite = new SqliteD1();
    try {
      await setFileMetadata(database(sqlite), "alpha", "gh/one.png", { app: "gh" });
      await setFileMetadata(database(sqlite), "alpha", "screenshots/one.png", { app: "gh" });

      const matches = await findObjectsByMetadata(
        database(sqlite),
        "alpha",
        { app: "gh" },
        { prefix: "gh/" },
      );
      expect(matches).toEqual([{ key: "gh/one.png", metadata: { app: "gh" } }]);
    } finally {
      sqlite.close();
    }
  });

  it("treats an underscore in the prefix literally, not as a SQL LIKE wildcard", async () => {
    const sqlite = new SqliteD1();
    try {
      await setFileMetadata(database(sqlite), "alpha", "my_app/x.png", { app: "a" });
      await setFileMetadata(database(sqlite), "alpha", "myxapp/x.png", { app: "a" });

      const matches = await findObjectsByMetadata(
        database(sqlite),
        "alpha",
        { app: "a" },
        { prefix: "my_app/" },
      );
      expect(matches).toEqual([{ key: "my_app/x.png", metadata: { app: "a" } }]);
    } finally {
      sqlite.close();
    }
  });

  it("respects a limit and returns an empty array for no filters or no matches", async () => {
    const sqlite = new SqliteD1();
    try {
      await setFileMetadata(database(sqlite), "alpha", "f/one.png", { app: "a" });
      await setFileMetadata(database(sqlite), "alpha", "f/two.png", { app: "a" });

      await expect(findObjectsByMetadata(database(sqlite), "alpha", {})).resolves.toEqual([]);
      await expect(
        findObjectsByMetadata(database(sqlite), "alpha", { app: "nope" }),
      ).resolves.toEqual([]);
      await expect(
        findObjectsByMetadata(database(sqlite), "alpha", { app: "a" }, { limit: 1 }),
      ).resolves.toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });
});
