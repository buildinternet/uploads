/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";
import { fileTypeClassFromKey } from "@uploads/comment-render/scope";
import { describe, expect, it } from "vitest";
import { fileTypeSql, parseFileTypeQuery } from "../src/file-type-sql";

const KEYS = [
  "a/shot.png",
  "a/SHOT.JPG",
  "b.jpeg",
  "c.webp",
  "d.gif",
  "e.avif",
  "f.mp4",
  "g.WEBM",
  "h.mov",
  "i.pdf",
  "j.txt",
  "no-extension",
  "k.png.zip",
  "l.mov.png",
  "x.jpg/",
  "mp4",
];

describe("fileTypeSql", () => {
  for (const type of ["screenshot", "video", "other"] as const) {
    it(`selects exactly the keys fileTypeClassFromKey calls ${type}`, () => {
      const db = new DatabaseSync(":memory:");
      try {
        const values = KEYS.map(() => "(?)").join(", ");
        const rows = db
          .prepare(
            `WITH t(k) AS (VALUES ${values}) SELECT k FROM t WHERE ${fileTypeSql("k", type)} ORDER BY k`,
          )
          .all(...KEYS) as Array<{ k: string }>;
        expect(rows.map((row) => row.k)).toEqual(
          KEYS.filter((key) => fileTypeClassFromKey(key) === type).sort(),
        );
      } finally {
        db.close();
      }
    });
  }

  it("never uses LIKE (D1's 50-byte pattern cap)", () => {
    expect(fileTypeSql("r.object_key", "screenshot")).not.toMatch(/LIKE|GLOB/i);
  });

  it("refuses a column that is not a plain identifier", () => {
    expect(() => fileTypeSql("k); DROP TABLE x; --", "video")).toThrow();
  });
});

describe("parseFileTypeQuery", () => {
  it("passes valid values, ignores empty, rejects the rest with invalid_type", () => {
    expect(parseFileTypeQuery(undefined)).toBeUndefined();
    expect(parseFileTypeQuery("")).toBeUndefined();
    expect(parseFileTypeQuery("video")).toBe("video");
    expect(() => parseFileTypeQuery("gif")).toThrow(/type must be/);
  });
});
