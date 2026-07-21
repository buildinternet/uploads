/// <reference types="node" />

import { AppError } from "@uploads/errors";
import { describe, expect, it } from "vitest";
import {
  META_MAX_KEYS,
  deleteFileMetadata,
  deleteFileMetadataForWorkspace,
  findObjectsByMetadata,
  getFileMetadata,
  getMetadataForKeys,
  replaceFileMetadata,
  setFileMetadata,
} from "../src/file-metadata";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const MIGRATION = "migrations/20260713210559_file_metadata.sql";

describe("file metadata persistence against SQLite", () => {
  it("returns an empty map for an object with no metadata", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      await expect(getFileMetadata(database(sqlite), "alpha", "f/one.png")).resolves.toEqual({});
    } finally {
      sqlite.close();
    }
  });

  it("sets, reads, and scopes metadata by workspace and object key", async () => {
    const sqlite = new SqliteD1(MIGRATION);
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
    const sqlite = new SqliteD1(MIGRATION);
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
    const sqlite = new SqliteD1(MIGRATION);
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
    const sqlite = new SqliteD1(MIGRATION);
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
    const sqlite = new SqliteD1(MIGRATION);
    try {
      await setFileMetadata(database(sqlite), "alpha", "f/one.png", { app: "screenshots" });
      await deleteFileMetadata(database(sqlite), "alpha", "f/one.png");
      await expect(getFileMetadata(database(sqlite), "alpha", "f/one.png")).resolves.toEqual({});
    } finally {
      sqlite.close();
    }
  });

  it("finds only objects matching ALL AND-ed filters, scoped by workspace", async () => {
    const sqlite = new SqliteD1(MIGRATION);
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
    const sqlite = new SqliteD1(MIGRATION);
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
    const sqlite = new SqliteD1(MIGRATION);
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
    const sqlite = new SqliteD1(MIGRATION);
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

  describe("replaceFileMetadata", () => {
    it("fully replaces prior metadata rather than merging", async () => {
      const sqlite = new SqliteD1(MIGRATION);
      try {
        await setFileMetadata(database(sqlite), "alpha", "f/one.png", {
          app: "screenshots",
          page: "/checkout",
        });

        await replaceFileMetadata(database(sqlite), "alpha", "f/one.png", { app: "other" });

        await expect(getFileMetadata(database(sqlite), "alpha", "f/one.png")).resolves.toEqual({
          app: "other",
        });
      } finally {
        sqlite.close();
      }
    });

    it("clears all metadata when replacing with an empty map", async () => {
      const sqlite = new SqliteD1(MIGRATION);
      try {
        await setFileMetadata(database(sqlite), "alpha", "f/one.png", { app: "screenshots" });

        await replaceFileMetadata(database(sqlite), "alpha", "f/one.png", {});

        await expect(getFileMetadata(database(sqlite), "alpha", "f/one.png")).resolves.toEqual({});
      } finally {
        sqlite.close();
      }
    });

    it("does not touch other objects or workspaces", async () => {
      const sqlite = new SqliteD1(MIGRATION);
      try {
        await setFileMetadata(database(sqlite), "alpha", "f/two.png", { app: "keep" });
        await setFileMetadata(database(sqlite), "beta", "f/one.png", { app: "keep" });

        await replaceFileMetadata(database(sqlite), "alpha", "f/one.png", { app: "new" });

        await expect(getFileMetadata(database(sqlite), "alpha", "f/two.png")).resolves.toEqual({
          app: "keep",
        });
        await expect(getFileMetadata(database(sqlite), "beta", "f/one.png")).resolves.toEqual({
          app: "keep",
        });
      } finally {
        sqlite.close();
      }
    });

    it("rejects metadata over the caps, writing nothing", async () => {
      const sqlite = new SqliteD1(MIGRATION);
      try {
        await setFileMetadata(database(sqlite), "alpha", "f/one.png", { app: "screenshots" });

        const tooMany: Record<string, string> = {};
        for (let i = 0; i < META_MAX_KEYS + 1; i++) tooMany[`k${i}`] = "v";

        await expect(
          replaceFileMetadata(database(sqlite), "alpha", "f/one.png", tooMany),
        ).rejects.toBeInstanceOf(AppError);

        // Rejected replace must not have touched the prior state.
        await expect(getFileMetadata(database(sqlite), "alpha", "f/one.png")).resolves.toEqual({
          app: "screenshots",
        });
      } finally {
        sqlite.close();
      }
    });

    it("is atomic: a batch failure leaves the prior metadata untouched", async () => {
      const sqlite = new SqliteD1(MIGRATION);
      try {
        await setFileMetadata(database(sqlite), "alpha", "f/one.png", { app: "screenshots" });

        // replaceFileMetadata's own validation can't fail mid-batch (it
        // runs before the batch is built), so exercise atomicity directly
        // against the transaction wrapper: a delete + insert followed by a
        // statement that violates a real constraint should roll back the
        // whole batch, including the delete and insert that preceded it.
        await expect(
          sqlite.batch([
            sqlite
              .prepare(`DELETE FROM file_metadata WHERE workspace = ? AND object_key = ?`)
              .bind("alpha", "f/one.png"),
            sqlite
              .prepare(
                `INSERT INTO file_metadata (workspace, object_key, meta_key, meta_value, updated_at) VALUES (?, ?, ?, ?, ?)`,
              )
              .bind("alpha", "f/one.png", "app", "replaced", "2026-07-13T00:00:00.000Z"),
            sqlite.prepare(`INSERT INTO no_such_table (x) VALUES (1)`),
          ]),
        ).rejects.toThrow();

        // Rolled back: the DELETE + INSERT from the failed batch never committed.
        await expect(getFileMetadata(database(sqlite), "alpha", "f/one.png")).resolves.toEqual({
          app: "screenshots",
        });
      } finally {
        sqlite.close();
      }
    });
  });

  describe("getMetadataForKeys", () => {
    it("returns per-key metadata maps, omits keys with no rows, scopes by workspace", async () => {
      const sqlite = new SqliteD1(MIGRATION);
      try {
        await replaceFileMetadata(database(sqlite), "ws1", "a.png", {
          "gh.repo": "o/r",
          "gh.number": "1",
        });
        await replaceFileMetadata(database(sqlite), "ws1", "b.png", {
          "gh.repo": "o/r",
          "gh.number": "2",
        });
        await replaceFileMetadata(database(sqlite), "ws2", "a.png", { "gh.repo": "other/x" });

        const out = await getMetadataForKeys(database(sqlite), "ws1", [
          "a.png",
          "b.png",
          "missing.png",
        ]);
        expect(out.get("a.png")).toEqual({ "gh.repo": "o/r", "gh.number": "1" });
        expect(out.get("b.png")).toEqual({ "gh.repo": "o/r", "gh.number": "2" });
        expect(out.has("missing.png")).toBe(false);
        expect(out.has("a.png")).toBe(true); // ws2's a.png must not leak
      } finally {
        sqlite.close();
      }
    });

    it("returns an empty map for empty keys without querying", async () => {
      const sqlite = new SqliteD1(MIGRATION);
      try {
        expect((await getMetadataForKeys(database(sqlite), "ws1", [])).size).toBe(0);
      } finally {
        sqlite.close();
      }
    });

    it("batches lookups over 100 keys into multiple statements and still returns all rows", async () => {
      const sqlite = new SqliteD1(MIGRATION);
      try {
        const keys = Array.from({ length: 150 }, (_, i) => `file-${i}.png`);
        for (const key of keys) {
          await replaceFileMetadata(database(sqlite), "ws1", key, { app: "screenshots" });
        }

        const out = await getMetadataForKeys(database(sqlite), "ws1", keys);
        expect(out.size).toBe(150);
        expect(out.get("file-0.png")).toEqual({ app: "screenshots" });
        expect(out.get("file-149.png")).toEqual({ app: "screenshots" });
      } finally {
        sqlite.close();
      }
    });

    it("restricts the result to opts.metaKeys when given", async () => {
      const sqlite = new SqliteD1(MIGRATION);
      try {
        await replaceFileMetadata(database(sqlite), "ws1", "a.png", {
          path: "/settings",
          state: "before",
          device: "iPhone 15 Pro",
          "gh.repo": "o/r",
        });

        const out = await getMetadataForKeys(database(sqlite), "ws1", ["a.png"], {
          metaKeys: ["path", "state"],
        });
        // The EXIF-derived key must not come back — the comment path relies on
        // this to keep `device`/`software` out of a public GitHub comment.
        expect(out.get("a.png")).toEqual({ path: "/settings", state: "before" });
      } finally {
        sqlite.close();
      }
    });

    it("omits a key entirely when it has none of the requested meta keys", async () => {
      const sqlite = new SqliteD1(MIGRATION);
      try {
        await replaceFileMetadata(database(sqlite), "ws1", "a.png", { "gh.repo": "o/r" });

        const out = await getMetadataForKeys(database(sqlite), "ws1", ["a.png"], {
          metaKeys: ["path", "state"],
        });
        expect(out.has("a.png")).toBe(false);
      } finally {
        sqlite.close();
      }
    });

    it("treats an omitted or empty metaKeys list as unfiltered", async () => {
      const sqlite = new SqliteD1(MIGRATION);
      try {
        const all = { path: "/settings", "gh.repo": "o/r" };
        await replaceFileMetadata(database(sqlite), "ws1", "a.png", all);

        // Empty array means "no filter", NOT "select nothing": a caller that
        // built the list dynamically is better served by the full map than by
        // a silently empty one.
        await expect(
          getMetadataForKeys(database(sqlite), "ws1", ["a.png"], { metaKeys: [] }),
        ).resolves.toEqual(new Map([["a.png", all]]));
        await expect(getMetadataForKeys(database(sqlite), "ws1", ["a.png"], {})).resolves.toEqual(
          new Map([["a.png", all]]),
        );
      } finally {
        sqlite.close();
      }
    });

    it("applies the filter across every chunk when keys exceed the chunk size", async () => {
      const sqlite = new SqliteD1(MIGRATION);
      try {
        const keys = Array.from({ length: 150 }, (_, i) => `f/${i}.png`);
        for (const key of keys) {
          await replaceFileMetadata(database(sqlite), "ws1", key, {
            path: "/p",
            device: "iPhone 15 Pro",
          });
        }

        const out = await getMetadataForKeys(database(sqlite), "ws1", keys, {
          metaKeys: ["path", "state"],
        });
        expect(out.size).toBe(150);
        // The 101st key proves the filter is bound into the second chunk too,
        // not just the first prepared statement.
        expect(out.get("f/100.png")).toEqual({ path: "/p" });
      } finally {
        sqlite.close();
      }
    });
  });

  describe("deleteFileMetadataForWorkspace", () => {
    it("wipes every row for a workspace, leaving other workspaces untouched", async () => {
      const sqlite = new SqliteD1(MIGRATION);
      try {
        await setFileMetadata(database(sqlite), "alpha", "f/one.png", { app: "screenshots" });
        await setFileMetadata(database(sqlite), "alpha", "f/two.png", { app: "screenshots" });
        await setFileMetadata(database(sqlite), "beta", "f/one.png", { app: "other" });

        await deleteFileMetadataForWorkspace(database(sqlite), "alpha");

        await expect(getFileMetadata(database(sqlite), "alpha", "f/one.png")).resolves.toEqual({});
        await expect(getFileMetadata(database(sqlite), "alpha", "f/two.png")).resolves.toEqual({});
        await expect(getFileMetadata(database(sqlite), "beta", "f/one.png")).resolves.toEqual({
          app: "other",
        });
      } finally {
        sqlite.close();
      }
    });
  });
});
