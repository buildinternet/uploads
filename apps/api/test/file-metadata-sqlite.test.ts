/// <reference types="node" />

import { AppError } from "@uploads/errors";
import { describe, expect, it } from "vitest";
import {
  META_MAX_KEYS,
  deleteFileMetadata,
  deleteFileMetadataForWorkspace,
  findObjectsByMetadata,
  getFileMetadata,
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
