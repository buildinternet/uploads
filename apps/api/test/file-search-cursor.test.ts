/**
 * Search cursor codec + D1 keyset continuation (issue #829 §4).
 *
 * The codec tests pin the opaque encoding's contract: round-trip, path
 * scoping, and a stable rejection `code`. The SQLite tests pin the `after`
 * option on `findObjectsByMetadata` against real SQL rather than the fake
 * table, since the continuation is a query-shape change.
 */
import { AppError } from "@uploads/errors";
import { describe, expect, it } from "vitest";
import { decodeSearchCursor, encodeSearchCursor, searchPathFor } from "../src/file-search";
import { findObjectsByMetadata, setFileMetadata } from "../src/file-metadata";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const MIGRATION = "migrations/20260713210559_file_metadata.sql";

describe("search cursor codec", () => {
  it("round-trips a key and is opaque (not the bare key)", () => {
    const cursor = encodeSearchCursor("meta", "shots/hero a.png");
    expect(cursor).not.toContain("shots/");
    expect(decodeSearchCursor(cursor, "meta")).toBe("shots/hero a.png");
  });

  it("round-trips keys with non-ASCII characters", () => {
    const cursor = encodeSearchCursor("name", "shots/café-née.png");
    expect(decodeSearchCursor(cursor, "name")).toBe("shots/café-née.png");
  });

  it("is URL-safe (no characters needing percent-encoding in a query param)", () => {
    const cursor = encodeSearchCursor("name", "a".repeat(64));
    expect(encodeURIComponent(cursor)).toBe(cursor);
  });

  it("rejects a cursor minted for the other search path", () => {
    const cursor = encodeSearchCursor("meta", "shots/a.png");
    expect(() => decodeSearchCursor(cursor, "name")).toThrow(AppError);
    try {
      decodeSearchCursor(cursor, "name");
    } catch (err) {
      expect((err as AppError).code).toBe("file_search_invalid_cursor");
      expect((err as AppError).status).toBe(400);
    }
  });

  it("rejects garbage, non-cursor JSON, and empty keys with the same code", () => {
    const rejected = [
      "not-a-cursor",
      btoa(JSON.stringify({ hello: "world" })),
      btoa(JSON.stringify({ v: 1, p: "meta", k: "" })),
      btoa(JSON.stringify({ v: 99, p: "meta", k: "shots/a.png" })),
    ];
    for (const raw of rejected) {
      try {
        decodeSearchCursor(raw, "meta");
        throw new Error(`expected rejection for ${raw}`);
      } catch (err) {
        expect((err as AppError).code).toBe("file_search_invalid_cursor");
      }
    }
  });

  it("derives the path from whether metadata filters are present", () => {
    expect(searchPathFor(undefined)).toBe("name");
    expect(searchPathFor({})).toBe("name");
    expect(searchPathFor({ app: "web" })).toBe("meta");
  });
});

describe("findObjectsByMetadata keyset continuation against SQLite", () => {
  async function seeded(): Promise<SqliteD1> {
    const sqlite = new SqliteD1(MIGRATION);
    for (const key of ["shots/a.png", "shots/b.png", "shots/c.png"]) {
      await setFileMetadata(database(sqlite), "alpha", key, { app: "web", team: "core" });
    }
    return sqlite;
  }

  it("resumes strictly after the given key", async () => {
    const sqlite = await seeded();
    try {
      const page = await findObjectsByMetadata(
        database(sqlite),
        "alpha",
        { app: "web" },
        { after: "shots/a.png" },
      );
      expect(page.map((row) => row.key)).toEqual(["shots/b.png", "shots/c.png"]);
    } finally {
      sqlite.close();
    }
  });

  it("resumes on the multi-filter INTERSECT form and with a prefix", async () => {
    const sqlite = await seeded();
    try {
      const page = await findObjectsByMetadata(
        database(sqlite),
        "alpha",
        { app: "web", team: "core" },
        { prefix: "shots/", after: "shots/b.png", limit: 10 },
      );
      expect(page.map((row) => row.key)).toEqual(["shots/c.png"]);
    } finally {
      sqlite.close();
    }
  });

  it("returns nothing once the cursor is past the last key", async () => {
    const sqlite = await seeded();
    try {
      const page = await findObjectsByMetadata(
        database(sqlite),
        "alpha",
        { app: "web" },
        { after: "shots/z.png" },
      );
      expect(page).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});
