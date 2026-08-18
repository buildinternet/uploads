/// <reference types="node" />

import { describe, expect, it } from "vitest";
import {
  adoptLedgerRow,
  adoptLedgerRowsForSource,
  adoptLedgerRowsForTarget,
  recordAdoptedLink,
  setAdoptLedgerDetached,
  setAdoptLedgerSource,
} from "../src/github-link-adopt-ledger";
import { database, SqliteD1 } from "./helpers/sqlite-d1";

const MIGRATIONS = ["migrations/20260818200000_github_adopted_links.sql"];

const row = (over: Partial<Parameters<typeof recordAdoptedLink>[1]> = {}) => ({
  repo: "acme/app",
  kind: "pull" as const,
  num: 7,
  sourceKey: "f/shot.png",
  workspace: "acme",
  objectKey: "gh/acme-app/pull-7/shot.png",
  source: "body",
  createdAt: "2026-08-18T00:00:00.000Z",
  ...over,
});

describe("github link adopt ledger", () => {
  it("records, reads back, and scopes by source", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      await recordAdoptedLink(db, row());
      await recordAdoptedLink(db, row({ sourceKey: "f/other.png", source: "comment:44" }));
      expect((await adoptLedgerRow(db, "acme/app", "pull", 7, "f/shot.png"))?.objectKey).toBe(
        "gh/acme-app/pull-7/shot.png",
      );
      expect(await adoptLedgerRowsForSource(db, "acme/app", "pull", 7, "body")).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  it("detach and re-attach flip detached_at; duplicate record is ignored", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      await recordAdoptedLink(db, row());
      await recordAdoptedLink(db, row({ objectKey: "gh/other.png" })); // INSERT OR IGNORE
      expect((await adoptLedgerRow(db, "acme/app", "pull", 7, "f/shot.png"))?.objectKey).toBe(
        "gh/acme-app/pull-7/shot.png",
      );
      await setAdoptLedgerDetached(
        db,
        "acme/app",
        "pull",
        7,
        "f/shot.png",
        "2026-08-19T00:00:00.000Z",
      );
      expect(
        (await adoptLedgerRow(db, "acme/app", "pull", 7, "f/shot.png"))?.detachedAt,
      ).not.toBeNull();
      await setAdoptLedgerDetached(db, "acme/app", "pull", 7, "f/shot.png", null);
      expect(
        (await adoptLedgerRow(db, "acme/app", "pull", 7, "f/shot.png"))?.detachedAt,
      ).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("adoptLedgerRowsForTarget scopes by repo+kind+num across every source", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      await recordAdoptedLink(db, row()); // source: "body"
      await recordAdoptedLink(
        db,
        row({ sourceKey: "f/other.png", source: "comment:44", objectKey: "gh/other-comment.png" }),
      );
      await recordAdoptedLink(
        db,
        row({ sourceKey: "f/y.png", num: 8, objectKey: "gh/other-num.png" }),
      ); // different num — must not be included
      await recordAdoptedLink(
        db,
        row({ sourceKey: "f/z.png", kind: "issues", objectKey: "gh/other-kind.png" }),
      ); // different kind — must not be included

      const rows = await adoptLedgerRowsForTarget(db, "acme/app", "pull", 7);
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.sourceKey))).toEqual(new Set(["f/shot.png", "f/other.png"]));
    } finally {
      sqlite.close();
    }
  });

  it("setAdoptLedgerSource moves a link between sources", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      await recordAdoptedLink(db, row());
      await setAdoptLedgerSource(db, "acme/app", "pull", 7, "f/shot.png", "comment:44");
      expect(await adoptLedgerRowsForSource(db, "acme/app", "pull", 7, "body")).toHaveLength(0);
      expect(await adoptLedgerRowsForSource(db, "acme/app", "pull", 7, "comment:44")).toHaveLength(
        1,
      );
    } finally {
      sqlite.close();
    }
  });
});
