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
import {
  decodeSearchCursor,
  encodeSearchCursor,
  searchPathFor,
  type SearchScope,
} from "../src/file-search";
import { findObjectsByMetadata, setFileMetadata } from "../src/file-metadata";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const MIGRATION = "migrations/20260713210559_file_metadata.sql";

const SCOPE: SearchScope = { workspaceName: "alpha", filters: { app: "web" } };
const NAME_SCOPE: SearchScope = { workspaceName: "alpha", nameTerm: "hero" };

/** Assert a thrown decode carries the stable rejection code. */
function expectRejected(run: () => unknown): void {
  try {
    run();
  } catch (err) {
    expect((err as AppError).code).toBe("file_search_invalid_cursor");
    expect((err as AppError).status).toBe(400);
    return;
  }
  throw new Error("expected the cursor to be rejected");
}

describe("search cursor codec", () => {
  it("round-trips a key and is opaque (not the bare key)", () => {
    const cursor = encodeSearchCursor("meta", SCOPE, "shots/hero a.png");
    expect(cursor).not.toContain("shots/");
    expect(decodeSearchCursor(cursor, "meta", SCOPE)).toBe("shots/hero a.png");
  });

  it("round-trips keys with non-ASCII characters", () => {
    const cursor = encodeSearchCursor("name", NAME_SCOPE, "shots/café-née.png");
    expect(decodeSearchCursor(cursor, "name", NAME_SCOPE)).toBe("shots/café-née.png");
  });

  it("is URL-safe (no characters needing percent-encoding in a query param)", () => {
    const cursor = encodeSearchCursor("name", NAME_SCOPE, "a".repeat(64));
    expect(encodeURIComponent(cursor)).toBe(cursor);
  });

  it("rejects a cursor minted for the other search path", () => {
    const cursor = encodeSearchCursor("meta", SCOPE, "shots/a.png");
    expectRejected(() => decodeSearchCursor(cursor, "name", SCOPE));
  });

  it("rejects garbage, non-cursor JSON, and empty keys with the same code", () => {
    const fingerprint = JSON.parse(atob(encodeSearchCursor("meta", SCOPE, "x"))).s as string;
    const rejected = [
      "not-a-cursor",
      btoa(JSON.stringify({ hello: "world" })),
      btoa(JSON.stringify({ v: 1, p: "meta", s: fingerprint, k: "" })),
      btoa(JSON.stringify({ v: 99, p: "meta", s: fingerprint, k: "shots/a.png" })),
      // A pre-scope cursor (no `s`) must not be honored either.
      btoa(JSON.stringify({ v: 1, p: "meta", k: "shots/a.png" })),
    ];
    for (const raw of rejected) expectRejected(() => decodeSearchCursor(raw, "meta", SCOPE));
  });

  /**
   * The reason the scope is bound at all: resuming at `key > :after` under a
   * different query would silently skip every match sorting before the previous
   * query's stopping point, with no way for the caller to notice.
   */
  it("rejects a cursor replayed against a different query scope", () => {
    const cursor = encodeSearchCursor("meta", SCOPE, "shots/m.png");
    const divergent: SearchScope[] = [
      { workspaceName: "alpha", filters: { app: "other" } },
      { workspaceName: "alpha", filters: { app: "web", team: "core" } },
      { workspaceName: "alpha", filters: { app: "web" }, nameTerm: "hero" },
      { workspaceName: "alpha", filters: { app: "web" }, prefix: "shots/" },
      { workspaceName: "alpha", filters: { app: "web" }, collapsePromotedShadows: true },
      { workspaceName: "beta", filters: { app: "web" } },
    ];
    for (const scope of divergent) expectRejected(() => decodeSearchCursor(cursor, "meta", scope));
  });

  it("accepts the same filters written in a different order", () => {
    const cursor = encodeSearchCursor(
      "meta",
      { workspaceName: "alpha", filters: { app: "web", team: "core" } },
      "shots/m.png",
    );
    expect(
      decodeSearchCursor(cursor, "meta", {
        workspaceName: "alpha",
        filters: { team: "core", app: "web" },
      }),
    ).toBe("shots/m.png");
  });

  it("does not let a filter key/value split shift across the boundary", () => {
    // Without length-prefixing, `{ "a": "b:c" }` and `{ "a:b": "c" }` would
    // flatten to the same canonical string and share a fingerprint.
    const cursor = encodeSearchCursor(
      "meta",
      { workspaceName: "alpha", filters: { a: "bc" } },
      "shots/m.png",
    );
    expectRejected(() =>
      decodeSearchCursor(cursor, "meta", { workspaceName: "alpha", filters: { ab: "c" } }),
    );
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

  /**
   * Collapse binds the workspace a second time (its correlated NOT EXISTS),
   * between the prefix binds and `after`. This is the combination where a
   * miscounted bind list silently reads the wrong argument as the cursor.
   */
  it("resumes correctly with collapsePromotedShadows on", async () => {
    const sqlite = await seeded();
    try {
      await setFileMetadata(database(sqlite), "alpha", "shots/b.png", {
        app: "web",
        team: "core",
        "gh.status": "promoted",
      });
      const all = await findObjectsByMetadata(
        database(sqlite),
        "alpha",
        { app: "web" },
        { collapsePromotedShadows: true },
      );
      expect(all.map((row) => row.key)).toEqual(["shots/a.png", "shots/c.png"]);

      const page = await findObjectsByMetadata(
        database(sqlite),
        "alpha",
        { app: "web" },
        { collapsePromotedShadows: true, after: "shots/a.png" },
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
