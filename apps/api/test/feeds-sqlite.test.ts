/// <reference types="node" />

import { describe, expect, it } from "vitest";
import { replaceFileMetadata } from "../src/file-metadata";
import {
  MAX_FEEDS_PER_WORKSPACE,
  createFeed,
  deleteFeedsForWorkspace,
  findFeedByRepoPath,
  getFeed,
  listFeeds,
  resolvePublicFeed,
  softDeleteFeed,
} from "../src/feeds";
import { findLatestRepoScreenshots } from "../src/feed-service";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const MIGRATIONS = [
  "migrations/20260713210559_file_metadata.sql",
  "migrations/20260915120000_feeds.sql",
];

function newSqlite(): SqliteD1 {
  return new SqliteD1(MIGRATIONS);
}

describe("feed persistence against SQLite", () => {
  it("creates a durable feed, reuses the same repo+path slot, and isolates tenants", async () => {
    const sqlite = newSqlite();
    try {
      const db = database(sqlite);
      const first = await createFeed(db, {
        workspace: "alpha",
        repo: "BuildInternet/Uploads",
        now: new Date("2026-09-15T12:00:00Z"),
      });
      expect(first.status).toBe("ok");
      if (first.status !== "ok") throw new Error("create failed");
      expect(first.created).toBe(true);
      expect(first.value.repo).toBe("buildinternet/uploads");
      expect(first.value.path).toBe("");
      expect(first.value.id).toMatch(/^feed_[A-Za-z0-9_-]{22}$/);

      const again = await createFeed(db, {
        workspace: "alpha",
        repo: "buildinternet/uploads",
      });
      expect(again.status).toBe("ok");
      if (again.status !== "ok") throw new Error("reuse failed");
      expect(again.created).toBe(false);
      expect(again.value.id).toBe(first.value.id);

      const otherPath = await createFeed(db, {
        workspace: "alpha",
        repo: "buildinternet/uploads",
        path: "/settings",
      });
      expect(otherPath.status).toBe("ok");
      if (otherPath.status !== "ok") throw new Error("path create failed");
      expect(otherPath.created).toBe(true);
      expect(otherPath.value.id).not.toBe(first.value.id);

      expect(await getFeed(db, "beta", first.value.id)).toBeNull();
      expect(await resolvePublicFeed(db, first.value.id)).toMatchObject({
        id: first.value.id,
        workspace: "alpha",
      });
    } finally {
      sqlite.close();
    }
  });

  it("rejects an invalid repo and a non-printable path", async () => {
    const sqlite = newSqlite();
    try {
      const db = database(sqlite);
      expect(await createFeed(db, { workspace: "alpha", repo: "not-a-repo" })).toMatchObject({
        status: "invalid",
        field: "repo",
      });
      expect(
        await createFeed(db, { workspace: "alpha", repo: "acme/app", path: "ok\nnope" }),
      ).toMatchObject({ status: "invalid", field: "path" });
    } finally {
      sqlite.close();
    }
  });

  it("lists newest first, soft-deletes, and lets the slot be reused after delete", async () => {
    const sqlite = newSqlite();
    try {
      const db = database(sqlite);
      const older = await createFeed(db, {
        workspace: "alpha",
        repo: "acme/one",
        now: new Date("2026-09-15T10:00:00Z"),
      });
      const newer = await createFeed(db, {
        workspace: "alpha",
        repo: "acme/two",
        now: new Date("2026-09-15T11:00:00Z"),
      });
      expect(older.status).toBe("ok");
      expect(newer.status).toBe("ok");
      if (older.status !== "ok" || newer.status !== "ok") throw new Error("create failed");

      const page = await listFeeds(db, "alpha", { limit: 1 });
      expect(page.feeds.map((feed) => feed.id)).toEqual([newer.value.id]);
      expect(page.nextCursor).toEqual({
        createdAt: newer.value.created_at,
        id: newer.value.id,
      });
      const rest = await listFeeds(db, "alpha", { limit: 10, cursor: page.nextCursor! });
      expect(rest.feeds.map((feed) => feed.id)).toEqual([older.value.id]);
      expect(rest.nextCursor).toBeNull();

      const deleted = await softDeleteFeed(db, "alpha", older.value.id);
      expect(deleted.status).toBe("ok");
      expect(await getFeed(db, "alpha", older.value.id)).toBeNull();
      expect(await resolvePublicFeed(db, older.value.id)).toBeNull();

      const recreated = await createFeed(db, { workspace: "alpha", repo: "acme/one" });
      expect(recreated.status).toBe("ok");
      if (recreated.status !== "ok") throw new Error("recreate failed");
      expect(recreated.created).toBe(true);
      expect(recreated.value.id).not.toBe(older.value.id);
    } finally {
      sqlite.close();
    }
  });

  it("enforces the per-workspace cap and hard-deletes on workspace teardown", async () => {
    const sqlite = newSqlite();
    try {
      const db = database(sqlite);
      for (let i = 0; i < MAX_FEEDS_PER_WORKSPACE; i++) {
        const created = await createFeed(db, { workspace: "alpha", repo: `acme/app${i}` });
        expect(created.status).toBe("ok");
      }
      expect(await createFeed(db, { workspace: "alpha", repo: "acme/overflow" })).toMatchObject({
        status: "limit",
        limit: MAX_FEEDS_PER_WORKSPACE,
      });
      const other = await createFeed(db, { workspace: "beta", repo: "acme/app" });
      expect(other.status).toBe("ok");

      const removed = await deleteFeedsForWorkspace(db, "alpha");
      expect(removed.feeds).toBe(MAX_FEEDS_PER_WORKSPACE);
      expect(await findFeedByRepoPath(db, "alpha", "acme/app0", "")).toBeNull();
      expect(other.status === "ok" && (await getFeed(db, "beta", other.value.id))).toMatchObject({
        repo: "acme/app",
      });
    } finally {
      sqlite.close();
    }
  });

  it("lists newest gh.repo matches, drops promoted shadows, and filters by path", async () => {
    const sqlite = newSqlite();
    try {
      const db = database(sqlite);
      await replaceFileMetadata(db, "alpha", "gh/acme/app/pull/1/old.png", {
        "gh.repo": "acme/app",
        path: "/settings",
      });
      // Stamp older updated_at so the later row wins newest-first.
      sqlite.db
        .prepare(`UPDATE file_metadata SET updated_at = ? WHERE workspace = ? AND object_key = ?`)
        .run("2026-09-01T00:00:00.000Z", "alpha", "gh/acme/app/pull/1/old.png");

      await replaceFileMetadata(db, "alpha", "gh/acme/app/pull/2/new.png", {
        "gh.repo": "acme/app",
        path: "/billing",
        state: "after",
      });
      await replaceFileMetadata(db, "alpha", "gh/acme/app/branch/feat/shadow.png", {
        "gh.repo": "acme/app",
        path: "/settings",
        "gh.status": "promoted",
      });
      await replaceFileMetadata(db, "alpha", "gh/other/app/pull/1/skip.png", {
        "gh.repo": "other/app",
        path: "/settings",
      });

      const latest = await findLatestRepoScreenshots(db, "alpha", { repo: "acme/app" });
      expect(latest.map((row) => row.key)).toEqual([
        "gh/acme/app/pull/2/new.png",
        "gh/acme/app/pull/1/old.png",
      ]);
      expect(latest[0]?.metadata.state).toBe("after");

      const settings = await findLatestRepoScreenshots(db, "alpha", {
        repo: "acme/app",
        path: "/settings",
      });
      expect(settings.map((row) => row.key)).toEqual(["gh/acme/app/pull/1/old.png"]);
    } finally {
      sqlite.close();
    }
  });
});
