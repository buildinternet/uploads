import { describe, expect, it } from "vitest";
import {
  applyInheritedMetaAdditively,
  inheritableMetaForHash,
  INHERITABLE_META_KEYS,
  recordContentHash,
} from "../src/content-hash";
import {
  getFileMetadata,
  META_MAX_KEYS,
  mergeWithinMetadataCaps,
  setFileMetadata,
} from "../src/file-metadata";
import { database, SqliteD1 } from "./helpers/sqlite-d1";

const MIGRATIONS = [
  "migrations/20260713210559_file_metadata.sql",
  "migrations/20260724140000_file_content_hash.sql",
];

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

/** Seed a donor object: its bytes hash, plus the derived tags it carries. */
async function seedDonor(
  sqlite: SqliteD1,
  workspace: string,
  key: string,
  hash: string,
  meta: Record<string, string>,
): Promise<void> {
  const db = database(sqlite);
  await recordContentHash(db, workspace, key, hash);
  if (Object.keys(meta).length > 0) await setFileMetadata(db, workspace, key, meta);
}

describe("inheritableMetaForHash", () => {
  it("returns the donor's derived tags for content-identical bytes", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      await seedDonor(sqlite, "alpha", "f/one.png", HASH_A, {
        path: "/settings/limits",
        state: "after",
      });

      const inherited = await inheritableMetaForHash(
        database(sqlite),
        "alpha",
        HASH_A,
        "f/two.png",
      );
      expect(inherited).toEqual({ path: "/settings/limits", state: "after" });
    } finally {
      sqlite.close();
    }
  });

  it("returns nothing when no object shares the bytes", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      await seedDonor(sqlite, "alpha", "f/one.png", HASH_A, { path: "/a" });
      expect(await inheritableMetaForHash(database(sqlite), "alpha", HASH_B, "f/two.png")).toEqual(
        {},
      );
    } finally {
      sqlite.close();
    }
  });

  it("inherits in `default` like any other workspace", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      // `default` was excluded while it was the communal tenant every account
      // belonged to. That concept is retired (#505) — it is an ordinary
      // workspace, so the ordinary rule applies.
      await seedDonor(sqlite, "default", "f/one.png", HASH_A, { path: "/admin/billing" });

      expect(
        await inheritableMetaForHash(database(sqlite), "default", HASH_A, "f/two.png"),
      ).toEqual({ path: "/admin/billing" });
    } finally {
      sqlite.close();
    }
  });

  it("does not cross workspaces", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      await seedDonor(sqlite, "alpha", "f/one.png", HASH_A, { path: "/a" });
      expect(await inheritableMetaForHash(database(sqlite), "beta", HASH_A, "f/two.png")).toEqual(
        {},
      );
    } finally {
      sqlite.close();
    }
  });

  it("does not treat the object itself as its own donor on overwrite", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      await seedDonor(sqlite, "alpha", "f/one.png", HASH_A, { path: "/a" });
      expect(await inheritableMetaForHash(database(sqlite), "alpha", HASH_A, "f/one.png")).toEqual(
        {},
      );
    } finally {
      sqlite.close();
    }
  });

  it("returns nothing rather than throwing when the lookup fails", async () => {
    // Only the metadata migration — `file_content_hash` does not exist, standing
    // in for a D1 blip. This runs after the bytes are durably stored, so the
    // upload must survive: losing inheritance costs metadata the caller can
    // re-state, throwing would cost bytes they would have to re-send.
    const sqlite = new SqliteD1("migrations/20260713210559_file_metadata.sql");
    try {
      expect(await inheritableMetaForHash(database(sqlite), "alpha", HASH_A, "f/two.png")).toEqual(
        {},
      );
    } finally {
      sqlite.close();
    }
  });

  it("filters the donor's tags to the inheritable vocabulary", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      await seedDonor(sqlite, "alpha", "f/one.png", HASH_A, {
        path: "/a",
        "gh.repo": "owner/repo",
        "gh.pr": "468",
        project: "something-custom",
      });

      const inherited = await inheritableMetaForHash(
        database(sqlite),
        "alpha",
        HASH_A,
        "f/two.png",
      );
      // `gh.*` is a claim about the donor's PR context, not a property of the
      // bytes — inheriting it would mint phantom PR activity.
      expect(inherited).toEqual({ path: "/a" });
    } finally {
      sqlite.close();
    }
  });

  it("picks the oldest donor deterministically when several share the bytes", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      await seedDonor(sqlite, "alpha", "f/first.png", HASH_A, { path: "/first" });
      await seedDonor(sqlite, "alpha", "f/second.png", HASH_A, { path: "/second" });
      // Force a strictly later timestamp on the second donor.
      await db
        .prepare(
          `UPDATE file_content_hash SET updated_at = ? WHERE workspace = ? AND object_key = ?`,
        )
        .bind("2999-01-01T00:00:00.000Z", "alpha", "f/second.png")
        .run();

      const inherited = await inheritableMetaForHash(db, "alpha", HASH_A, "f/third.png");
      expect(inherited).toEqual({ path: "/first" });
    } finally {
      sqlite.close();
    }
  });
});

describe("recordContentHash", () => {
  it("replaces a key's hash on overwrite rather than accumulating rows", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      await recordContentHash(db, "alpha", "f/one.png", HASH_A);
      await recordContentHash(db, "alpha", "f/one.png", HASH_B);

      const rows = await db
        .prepare(`SELECT content_sha256 FROM file_content_hash WHERE workspace = ?`)
        .bind("alpha")
        .all<{ content_sha256: string }>();
      expect(rows.results).toEqual([{ content_sha256: HASH_B }]);
    } finally {
      sqlite.close();
    }
  });
});

describe("mergeWithinMetadataCaps", () => {
  it("lets explicit keys win over inherited ones", () => {
    expect(
      mergeWithinMetadataCaps({ path: "/explicit" }, { path: "/inherited", state: "after" }),
    ).toEqual({ path: "/explicit", state: "after" });
  });

  it("drops overflow rather than failing, matching mergeDerivedMeta", () => {
    // A full explicit budget must never fail an upload — the CLI's
    // mergeDerivedMeta makes the same call for capture-time derived keys.
    const explicit: Record<string, string> = {};
    for (let i = 0; i < META_MAX_KEYS; i += 1) explicit[`k${i}`] = "v";

    const merged = mergeWithinMetadataCaps(explicit, { path: "/a" });
    expect(Object.keys(merged)).toHaveLength(META_MAX_KEYS);
    expect(merged.path).toBeUndefined();
  });

  it("does not let server-owned keys consume the user's key budget", () => {
    // Same exemption validateMetadataEntries applies: a video upload's four
    // video.* rows must not cost the user four of their META_MAX_KEYS slots,
    // and so must not block an inherited key either.
    const base: Record<string, string> = { "video.poster": "f/p.jpg", "video.width": "1280" };
    for (let i = 0; i < META_MAX_KEYS - 1; i += 1) base[`k${i}`] = "v";

    const merged = mergeWithinMetadataCaps(base, { path: "/a" });
    expect(merged.path).toBe("/a");
  });

  it("adds what fits when only some inherited keys overflow", () => {
    const explicit: Record<string, string> = {};
    for (let i = 0; i < META_MAX_KEYS - 1; i += 1) explicit[`k${i}`] = "v";

    const merged = mergeWithinMetadataCaps(explicit, { path: "/a", state: "after" });
    expect(Object.keys(merged)).toHaveLength(META_MAX_KEYS);
    expect(merged.path).toBe("/a");
    expect(merged.state).toBeUndefined();
  });
});

describe("applyInheritedMetaAdditively", () => {
  it("adds inherited keys without disturbing tags already on the object", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      await setFileMetadata(db, "alpha", "f/two.png", { "gh.repo": "owner/repo" });

      const stored = await applyInheritedMetaAdditively(db, "alpha", "f/two.png", {
        path: "/a",
      });

      expect(stored).toEqual({ "gh.repo": "owner/repo", path: "/a" });
      expect(await getFileMetadata(db, "alpha", "f/two.png")).toEqual({
        "gh.repo": "owner/repo",
        path: "/a",
      });
    } finally {
      sqlite.close();
    }
  });

  it("never overwrites a key the object already carries", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      await setFileMetadata(db, "alpha", "f/two.png", { path: "/mine" });

      const stored = await applyInheritedMetaAdditively(db, "alpha", "f/two.png", {
        path: "/donor",
      });

      expect(stored).toBeUndefined();
      expect(await getFileMetadata(db, "alpha", "f/two.png")).toEqual({ path: "/mine" });
    } finally {
      sqlite.close();
    }
  });

  it("writes nothing when there is nothing to inherit", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      expect(await applyInheritedMetaAdditively(db, "alpha", "f/two.png", {})).toBeUndefined();
      expect(await getFileMetadata(db, "alpha", "f/two.png")).toEqual({});
    } finally {
      sqlite.close();
    }
  });
});

describe("INHERITABLE_META_KEYS", () => {
  it("excludes gh.* so inherited tags cannot mint phantom PR activity", () => {
    expect(INHERITABLE_META_KEYS.some((key) => key.startsWith("gh."))).toBe(false);
  });

  it("excludes reserved server keys", () => {
    for (const key of ["content-sha256", "visibility", "video.poster"]) {
      expect((INHERITABLE_META_KEYS as readonly string[]).includes(key)).toBe(false);
    }
  });
});
