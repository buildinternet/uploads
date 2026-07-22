import { AppError, InternalError } from "@uploads/errors";
import { describe, expect, it } from "vitest";
import {
  getFileMetadata,
  isServerMetaKey,
  META_KEY_RE,
  META_MAX_KEYS,
  META_MAX_TOTAL_BYTES,
  META_VALUE_MAX,
  setFileMetadata,
  setServerFileMetadata,
  validateMetadataEntries,
  validateStoredMetadataEntries,
} from "../src/file-metadata";
import { database, SqliteD1 } from "./helpers/sqlite-d1";

const FILE_METADATA_MIGRATION = "migrations/20260713210559_file_metadata.sql";

describe("META_KEY_RE", () => {
  it("accepts lowercase, digit, dot, underscore, and dash keys starting with a letter", () => {
    for (const key of ["app", "gh.repo", "device_type", "resolution-2x", "a", "a".repeat(64)]) {
      expect(META_KEY_RE.test(key)).toBe(true);
    }
  });

  it("rejects keys that are empty, too long, uppercase, or start wrong", () => {
    for (const key of [
      "",
      "a".repeat(65),
      "Gh.repo",
      "1abc",
      "_abc",
      "-abc",
      "has space",
      "emoji😀",
    ]) {
      expect(META_KEY_RE.test(key)).toBe(false);
    }
  });
});

describe("validateMetadataEntries", () => {
  it("accepts a well-formed map", () => {
    expect(() => validateMetadataEntries({ app: "screenshots", "gh.repo": "a/b" })).not.toThrow();
  });

  it("throws AppError for an invalid key", () => {
    expect(() => validateMetadataEntries({ "Bad Key": "x" })).toThrow(AppError);
  });

  it("throws a reserved-key AppError for server-set provenance keys like content-sha256", () => {
    try {
      validateMetadataEntries({ "content-sha256": "0".repeat(64) });
      throw new Error("expected validateMetadataEntries to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError & { code?: string }).code).toBe("file_metadata_reserved_key");
    }
    // gh.* keys stay writable — system-managed by convention, not reserved.
    expect(() => validateMetadataEntries({ "gh.repo": "a/b" })).not.toThrow();
  });

  it("throws a reserved-key AppError for `visibility` (would shadow the R2 visibility gate)", () => {
    try {
      validateMetadataEntries({ visibility: "private" });
      throw new Error("expected validateMetadataEntries to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError & { code?: string }).code).toBe("file_metadata_reserved_key");
    }
  });

  it("throws AppError for an empty value", () => {
    expect(() => validateMetadataEntries({ app: "" })).toThrow(AppError);
  });

  it("throws AppError for a value over META_VALUE_MAX", () => {
    expect(() => validateMetadataEntries({ app: "x".repeat(META_VALUE_MAX + 1) })).toThrow(
      AppError,
    );
    expect(() => validateMetadataEntries({ app: "x".repeat(META_VALUE_MAX) })).not.toThrow();
  });

  it("throws AppError for a non-printable value", () => {
    expect(() => validateMetadataEntries({ app: "café" })).toThrow(AppError);
    expect(() => validateMetadataEntries({ app: "line\nbreak" })).toThrow(AppError);
  });

  it("throws AppError when the map has more than META_MAX_KEYS entries", () => {
    const tooMany: Record<string, string> = {};
    for (let i = 0; i < META_MAX_KEYS + 1; i++) tooMany[`k${i}`] = "v";
    expect(() => validateMetadataEntries(tooMany)).toThrow(AppError);

    const atCap: Record<string, string> = {};
    for (let i = 0; i < META_MAX_KEYS; i++) atCap[`k${i}`] = "v";
    expect(() => validateMetadataEntries(atCap)).not.toThrow();
  });

  it("throws AppError when total key+value UTF-8 bytes exceed META_MAX_TOTAL_BYTES", () => {
    // One giant value alone should trip the total-bytes cap even though it's a
    // single key under META_MAX_KEYS and under META_VALUE_MAX.
    const many: Record<string, string> = {};
    let bytes = 0;
    for (let i = 0; i < META_MAX_KEYS && bytes <= META_MAX_TOTAL_BYTES; i++) {
      const key = `k${i}`;
      const value = "x".repeat(META_VALUE_MAX);
      many[key] = value;
      bytes += key.length + value.length;
    }
    expect(() => validateMetadataEntries(many)).toThrow(AppError);
  });

  it("is a validation-family AppError with the invalid-request status", () => {
    try {
      validateMetadataEntries({ "Bad Key": "x" });
      throw new Error("expected validateMetadataEntries to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).type).toBe("validation");
      expect((err as AppError).status).toBe(400);
    }
  });
});

describe("setFileMetadata: reserved/server-owned keys cannot be deleted", () => {
  // A client that cannot SET these keys (validateMetadataEntries rejects
  // them on the write path) must not be able to DELETE them either — issue
  // #365's follow-up: deleting video.poster/visibility/content-sha256 by
  // name would silently blank a value the server owns.

  it("throws the reserved-key ValidationError when deleting video.poster", async () => {
    const sqlite = new SqliteD1(FILE_METADATA_MIGRATION);
    try {
      try {
        await setFileMetadata(database(sqlite), "alpha", "f/one.png", {}, ["video.poster"]);
        throw new Error("expected setFileMetadata to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError & { code?: string }).code).toBe("file_metadata_reserved_key");
      }
    } finally {
      sqlite.close();
    }
  });

  it("throws the reserved-key ValidationError when deleting visibility", async () => {
    const sqlite = new SqliteD1(FILE_METADATA_MIGRATION);
    try {
      try {
        await setFileMetadata(database(sqlite), "alpha", "f/one.png", {}, ["visibility"]);
        throw new Error("expected setFileMetadata to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError & { code?: string }).code).toBe("file_metadata_reserved_key");
      }
    } finally {
      sqlite.close();
    }
  });

  it("throws the reserved-key ValidationError when deleting content-sha256", async () => {
    const sqlite = new SqliteD1(FILE_METADATA_MIGRATION);
    try {
      try {
        await setFileMetadata(database(sqlite), "alpha", "f/one.png", {}, ["content-sha256"]);
        throw new Error("expected setFileMetadata to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError & { code?: string }).code).toBe("file_metadata_reserved_key");
      }
    } finally {
      sqlite.close();
    }
  });

  it("still deletes an ordinary key exactly as before", async () => {
    const sqlite = new SqliteD1(FILE_METADATA_MIGRATION);
    try {
      await setFileMetadata(database(sqlite), "alpha", "f/one.png", {
        path: "/checkout",
        app: "screenshots",
      });

      const result = await setFileMetadata(database(sqlite), "alpha", "f/one.png", {}, ["path"]);

      expect(result).toEqual({ app: "screenshots" });
      await expect(getFileMetadata(database(sqlite), "alpha", "f/one.png")).resolves.toEqual({
        app: "screenshots",
      });
    } finally {
      sqlite.close();
    }
  });

  it("still no-ops when deleting a non-existent ordinary key", async () => {
    const sqlite = new SqliteD1(FILE_METADATA_MIGRATION);
    try {
      await setFileMetadata(database(sqlite), "alpha", "f/one.png", { app: "screenshots" });

      const result = await setFileMetadata(database(sqlite), "alpha", "f/one.png", {}, [
        "does-not-exist",
      ]);

      expect(result).toEqual({ app: "screenshots" });
      await expect(getFileMetadata(database(sqlite), "alpha", "f/one.png")).resolves.toEqual({
        app: "screenshots",
      });
    } finally {
      sqlite.close();
    }
  });

  it("rejects a mixed delete list and does not partially delete the ordinary keys", async () => {
    const sqlite = new SqliteD1(FILE_METADATA_MIGRATION);
    try {
      await setFileMetadata(database(sqlite), "alpha", "f/one.png", {
        app: "screenshots",
        path: "/checkout",
      });

      await expect(
        setFileMetadata(database(sqlite), "alpha", "f/one.png", {}, ["path", "visibility"]),
      ).rejects.toBeInstanceOf(AppError);

      // Neither ordinary key in the mixed list was removed — the reserved
      // key in the same list must block the whole call, not just itself.
      await expect(getFileMetadata(database(sqlite), "alpha", "f/one.png")).resolves.toEqual({
        app: "screenshots",
        path: "/checkout",
      });
    } finally {
      sqlite.close();
    }
  });
});

describe("setFileMetadata: post-merge validation must not re-reject stored server keys", () => {
  // Regression for the bug in issue #365's cleanup review: once a video has
  // a poster, `current` (read inside setFileMetadata) already contains
  // video.* rows. The post-merge check exists to enforce the count/byte caps
  // on the merged result, not to re-police provenance — it must not throw
  // just because a server-owned key is present in the stored state.
  it("lets an ordinary metadata PATCH succeed on a file that already has video.* rows", async () => {
    const sqlite = new SqliteD1(FILE_METADATA_MIGRATION);
    try {
      await setServerFileMetadata(database(sqlite), "alpha", "f/clip.mp4", {
        "video.poster": "1",
        "video.duration": "14",
      });

      const result = await setFileMetadata(database(sqlite), "alpha", "f/clip.mp4", {
        path: "/checkout",
      });

      expect(result).toEqual({
        "video.poster": "1",
        "video.duration": "14",
        path: "/checkout",
      });
      await expect(getFileMetadata(database(sqlite), "alpha", "f/clip.mp4")).resolves.toEqual({
        "video.poster": "1",
        "video.duration": "14",
        path: "/checkout",
      });
    } finally {
      sqlite.close();
    }
  });
});

describe("getFileMetadata", () => {
  it("wraps raw D1 failures in InternalError", async () => {
    const db = {
      prepare: () => ({
        bind: () => ({
          all: async () => {
            throw new Error("D1_ERROR: database is locked");
          },
        }),
      }),
    } as unknown as D1Database;
    await expect(getFileMetadata(db, "ws", "f/one.png")).rejects.toBeInstanceOf(InternalError);
  });
});

describe("server-owned video.* namespace", () => {
  it("recognizes the namespace", () => {
    expect(isServerMetaKey("video.poster")).toBe(true);
    expect(isServerMetaKey("video.duration")).toBe(true);
    expect(isServerMetaKey("videoclip")).toBe(false);
    expect(isServerMetaKey("path")).toBe(false);
  });

  it("rejects a client write to the namespace", () => {
    expect(() => validateMetadataEntries({ "video.poster": "1" })).toThrow(/reserved metadata key/);
  });

  it("allows a server write when opted in", () => {
    expect(() => validateStoredMetadataEntries({ "video.poster": "1" })).not.toThrow();
  });

  it("still rejects RESERVED_META_KEYS through the stored-entries variant", () => {
    expect(() => validateStoredMetadataEntries({ visibility: "private" })).toThrow(
      /reserved metadata key/,
    );
  });

  it("excludes server keys from the per-object key cap", () => {
    const meta: Record<string, string> = { "video.poster": "1", "video.duration": "14" };
    for (let i = 0; i < META_MAX_KEYS; i++) meta[`k${i}`] = "v";
    // 24 user keys + 2 server keys must still pass.
    expect(() => validateStoredMetadataEntries(meta)).not.toThrow();
    meta.overflow = "v";
    expect(() => validateStoredMetadataEntries(meta)).toThrow(/at most 24 keys/);
  });
});
