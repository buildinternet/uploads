/// <reference types="node" />

import { describe, expect, it } from "vitest";
import {
  ledgerRow,
  ledgerRowsForSource,
  ledgerRowsForTarget,
  recordIngestedAsset,
  setLedgerDetached,
  setLedgerSource,
} from "../src/github-ingest-ledger";
import { database, SqliteD1 } from "./helpers/sqlite-d1";

const MIGRATIONS = ["migrations/20260811120000_github_ingested_assets.sql"];

const row = (over: Partial<Parameters<typeof recordIngestedAsset>[1]> = {}) => ({
  repo: "acme/app",
  assetId: "assets/aaaa-bbbb",
  workspace: "acme",
  objectKey: "gh/acme-app/pull-7/aaaa-bbbb.png",
  kind: "pull" as const,
  num: 7,
  source: "body",
  createdAt: "2026-08-11T00:00:00.000Z",
  ...over,
});

describe("github ingest ledger", () => {
  it("records, reads back, and scopes by source", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      await recordIngestedAsset(db, row());
      await recordIngestedAsset(db, row({ assetId: "files/9/x.png", source: "comment:44" }));
      expect((await ledgerRow(db, "acme/app", "assets/aaaa-bbbb"))?.objectKey).toBe(
        "gh/acme-app/pull-7/aaaa-bbbb.png",
      );
      expect(await ledgerRowsForSource(db, "acme/app", "body")).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  it("detach and re-attach flip detached_at; duplicate record is ignored", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      await recordIngestedAsset(db, row());
      await recordIngestedAsset(db, row({ objectKey: "gh/other.png" })); // INSERT OR IGNORE
      expect((await ledgerRow(db, "acme/app", "assets/aaaa-bbbb"))?.objectKey).toBe(
        "gh/acme-app/pull-7/aaaa-bbbb.png",
      );
      await setLedgerDetached(db, "acme/app", "assets/aaaa-bbbb", "2026-08-12T00:00:00.000Z");
      expect((await ledgerRow(db, "acme/app", "assets/aaaa-bbbb"))?.detachedAt).not.toBeNull();
      await setLedgerDetached(db, "acme/app", "assets/aaaa-bbbb", null);
      expect((await ledgerRow(db, "acme/app", "assets/aaaa-bbbb"))?.detachedAt).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("ledgerRowsForTarget scopes by repo+kind+num across every source", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      await recordIngestedAsset(db, row()); // source: "body"
      await recordIngestedAsset(
        db,
        row({ assetId: "files/9/x.png", source: "comment:44", objectKey: "gh/other-comment.png" }),
      );
      await recordIngestedAsset(
        db,
        row({
          assetId: "files/1/y.png",
          num: 8,
          objectKey: "gh/other-num.png",
        }),
      ); // different num — must not be included
      await recordIngestedAsset(
        db,
        row({
          assetId: "files/2/z.png",
          kind: "issues",
          objectKey: "gh/other-kind.png",
        }),
      ); // different kind — must not be included

      const rows = await ledgerRowsForTarget(db, "acme/app", "pull", 7);
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.assetId))).toEqual(
        new Set(["assets/aaaa-bbbb", "files/9/x.png"]),
      );
    } finally {
      sqlite.close();
    }
  });

  it("setLedgerSource moves an asset between sources", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      await recordIngestedAsset(db, row());
      await setLedgerSource(db, "acme/app", "assets/aaaa-bbbb", "comment:44");
      expect(await ledgerRowsForSource(db, "acme/app", "body")).toHaveLength(0);
      expect(await ledgerRowsForSource(db, "acme/app", "comment:44")).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });
});
