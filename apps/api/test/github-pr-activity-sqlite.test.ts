/// <reference types="node" />

import { describe, expect, it } from "vitest";
import {
  listPrActivityForWorkspace,
  recordPrActivityFromMetadata,
  recordPrMediaActivity,
} from "../src/github-pr-activity";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const MIGRATION = "migrations/20260721150000_github_pr_activity.sql";

describe("github pr activity persistence against SQLite", () => {
  it("returns an empty feed for a workspace with no activity", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      await expect(listPrActivityForWorkspace(database(sqlite), "acme", 20)).resolves.toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("records an event and lowercases the repo into the ref", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      await recordPrMediaActivity(database(sqlite), {
        repo: "Acme/Web",
        prNumber: 7,
        branch: "feat/x",
        workspaceName: "acme",
        count: 2,
      });
      const [row] = await listPrActivityForWorkspace(database(sqlite), "acme", 20);
      expect(row).toMatchObject({
        ref: "acme/web#7",
        repo: "acme/web",
        prNumber: 7,
        branch: "feat/x",
        workspaceName: "acme",
        mediaCount: 2,
      });
      expect(row.firstMediaAt).toBe(row.lastMediaAt);
    } finally {
      sqlite.close();
    }
  });

  it("upserts: increments the count, advances last_media_at, keeps first_media_at", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      const t1 = new Date("2026-07-21T10:00:00Z");
      const t2 = new Date("2026-07-21T11:00:00Z");
      const event = { repo: "acme/web", prNumber: 7, workspaceName: "acme", count: 1 };
      await recordPrMediaActivity(db, { ...event, branch: "feat/x" }, t1);
      await recordPrMediaActivity(db, { ...event, branch: null }, t2);
      const [row] = await listPrActivityForWorkspace(db, "acme", 20);
      expect(row.mediaCount).toBe(2);
      expect(row.firstMediaAt).toBe(t1.toISOString());
      expect(row.lastMediaAt).toBe(t2.toISOString());
      // A null branch never clobbers a previously recorded one (COALESCE).
      expect(row.branch).toBe("feat/x");
    } finally {
      sqlite.close();
    }
  });

  it("orders the feed by most recent activity and honors the limit", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      for (const [num, at] of [
        [1, "2026-07-21T10:00:00Z"],
        [2, "2026-07-21T12:00:00Z"],
        [3, "2026-07-21T11:00:00Z"],
      ] as const) {
        await recordPrMediaActivity(
          db,
          { repo: "acme/web", prNumber: num, workspaceName: "acme", count: 1 },
          new Date(at),
        );
      }
      const rows = await listPrActivityForWorkspace(db, "acme", 2);
      expect(rows.map((r) => r.prNumber)).toEqual([2, 3]);
    } finally {
      sqlite.close();
    }
  });

  it("scopes the feed to the requested workspace", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      await recordPrMediaActivity(db, {
        repo: "acme/web",
        prNumber: 1,
        workspaceName: "acme",
        count: 1,
      });
      await recordPrMediaActivity(db, {
        repo: "other/repo",
        prNumber: 2,
        workspaceName: "other",
        count: 1,
      });
      const rows = await listPrActivityForWorkspace(db, "acme", 20);
      expect(rows).toHaveLength(1);
      expect(rows[0].ref).toBe("acme/web#1");
    } finally {
      sqlite.close();
    }
  });
});

describe("recordPrActivityFromMetadata", () => {
  it("records only well-formed gh.kind=pull tag sets", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      await recordPrActivityFromMetadata(db, "acme", {
        "gh.repo": "acme/web",
        "gh.kind": "pull",
        "gh.number": "7",
        "gh.branch": "feat/x",
      });
      // Ignored: branch-staged, issue attach, malformed number, missing repo.
      await recordPrActivityFromMetadata(db, "acme", {
        "gh.repo": "acme/web",
        "gh.kind": "branch",
        "gh.branch": "feat/x",
      });
      await recordPrActivityFromMetadata(db, "acme", {
        "gh.repo": "acme/web",
        "gh.kind": "issue",
        "gh.number": "9",
      });
      await recordPrActivityFromMetadata(db, "acme", {
        "gh.repo": "acme/web",
        "gh.kind": "pull",
        "gh.number": "nope",
      });
      await recordPrActivityFromMetadata(db, "acme", { "gh.kind": "pull", "gh.number": "7" });
      const rows = await listPrActivityForWorkspace(db, "acme", 20);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ ref: "acme/web#7", branch: "feat/x", mediaCount: 1 });
    } finally {
      sqlite.close();
    }
  });
});
