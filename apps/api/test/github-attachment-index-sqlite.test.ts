/// <reference types="node" />

import { describe, expect, it } from "vitest";
import {
  attachmentRow,
  deleteAttachment,
  deleteAttachmentsForKeys,
  deleteAttachmentsForWorkspace,
  detachAttachment,
  parseAttachmentKey,
  reattachAttachment,
  recordAttachment,
} from "../src/github-attachment-index";
import { database, SqliteD1 } from "./helpers/sqlite-d1";

const MIGRATIONS = ["migrations/20260903120000_github_attachments.sql"];

const row = (over: Partial<Parameters<typeof recordAttachment>[1]> = {}) => ({
  workspace: "acme",
  repo: "acme/web",
  kind: "pull" as const,
  num: 12,
  objectKey: "gh/acme/web/pull/12/hero.png",
  prefixId: null,
  laneId: null,
  source: "put" as const,
  ...over,
});

describe("parseAttachmentKey", () => {
  it("parses a plain gh key and recovers the sanitized repo", () => {
    expect(parseAttachmentKey("gh/Acme/Web/pull/12/hero.png")).toEqual({
      kind: "pull",
      num: 12,
      prefixId: null,
      repo: "acme/web",
    });
    expect(parseAttachmentKey("gh/acme/web/issues/3/a.png")).toEqual({
      kind: "issues",
      num: 3,
      prefixId: null,
      repo: "acme/web",
    });
  });

  it("parses a private key but cannot recover the repo", () => {
    const id = "a".repeat(32);
    expect(parseAttachmentKey(`gh/private/${id}/pull/12/hero.png`)).toEqual({
      kind: "pull",
      num: 12,
      prefixId: id,
      repo: null,
    });
  });

  it("returns undefined for ingest keys (plain and private)", () => {
    expect(parseAttachmentKey("gh/acme-web/pull-12/asset-1.png")).toBeUndefined();
    expect(
      parseAttachmentKey(`gh/private/${"b".repeat(32)}/ingest/pull-12/asset-1.png`),
    ).toBeUndefined();
  });

  it("returns undefined for branch-staged, malformed, and non-gh keys", () => {
    expect(parseAttachmentKey("gh/acme/web/branch/feat-x/hero.png")).toBeUndefined();
    expect(parseAttachmentKey(`gh/private/${"c".repeat(32)}/branch/hero.png`)).toBeUndefined();
    expect(parseAttachmentKey("gh/acme/web/pull/0/hero.png")).toBeUndefined();
    expect(parseAttachmentKey("gh/acme/web/pull/12/")).toBeUndefined();
    expect(parseAttachmentKey("gh/acme/web/pull/abc/hero.png")).toBeUndefined();
    expect(parseAttachmentKey("f/abc/hero.png")).toBeUndefined();
    expect(parseAttachmentKey("gh/private/short/pull/12/hero.png")).toBeUndefined();
  });
});

describe("recordAttachment", () => {
  it("inserts a row and reads it back", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      await recordAttachment(db, row(), new Date("2026-09-03T00:00:00.000Z"));
      const stored = await attachmentRow(db, "acme", "gh/acme/web/pull/12/hero.png");
      expect(stored).toMatchObject({
        workspace: "acme",
        repo: "acme/web",
        kind: "pull",
        num: 12,
        objectKey: "gh/acme/web/pull/12/hero.png",
        prefixId: null,
        laneId: null,
        source: "put",
        createdAt: "2026-09-03T00:00:00.000Z",
        updatedAt: "2026-09-03T00:00:00.000Z",
        detachedAt: null,
      });
    } finally {
      sqlite.close();
    }
  });

  it("upserts on (workspace, object_key): one row, fields updated, created_at kept", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      await recordAttachment(db, row(), new Date("2026-09-03T00:00:00.000Z"));
      await recordAttachment(
        db,
        row({ source: "attach", laneId: "lane-b", prefixId: "d".repeat(32) }),
        new Date("2026-09-04T00:00:00.000Z"),
      );
      const stored = await attachmentRow(db, "acme", "gh/acme/web/pull/12/hero.png");
      expect(stored).toMatchObject({
        source: "attach",
        laneId: "lane-b",
        prefixId: "d".repeat(32),
        createdAt: "2026-09-03T00:00:00.000Z",
        updatedAt: "2026-09-04T00:00:00.000Z",
      });
      const all = await db
        .prepare("SELECT COUNT(*) AS count FROM github_attachments")
        .bind()
        .first<{ count: number }>();
      expect(all?.count).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it("lowercases the repo and scopes by workspace", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      await recordAttachment(db, row({ repo: "Acme/Web" }));
      await recordAttachment(db, row({ workspace: "other" }));
      expect((await attachmentRow(db, "acme", "gh/acme/web/pull/12/hero.png"))?.repo).toBe(
        "acme/web",
      );
      expect(await attachmentRow(db, "other", "gh/acme/web/pull/12/hero.png")).not.toBeNull();
      expect(await attachmentRow(db, "nobody", "gh/acme/web/pull/12/hero.png")).toBeNull();
    } finally {
      sqlite.close();
    }
  });
});

describe("detachAttachment / reattachAttachment", () => {
  it("flips detached_at and back, bumping updated_at", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      await recordAttachment(db, row(), new Date("2026-09-03T00:00:00.000Z"));
      await detachAttachment(db, "acme", row().objectKey, new Date("2026-09-05T00:00:00.000Z"));
      expect(await attachmentRow(db, "acme", row().objectKey)).toMatchObject({
        detachedAt: "2026-09-05T00:00:00.000Z",
        updatedAt: "2026-09-05T00:00:00.000Z",
      });
      await reattachAttachment(db, "acme", row().objectKey, new Date("2026-09-06T00:00:00.000Z"));
      expect(await attachmentRow(db, "acme", row().objectKey)).toMatchObject({
        detachedAt: null,
        updatedAt: "2026-09-06T00:00:00.000Z",
      });
    } finally {
      sqlite.close();
    }
  });

  it("recordAttachment clears a previously-set detached_at", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      await recordAttachment(db, row());
      await detachAttachment(db, "acme", row().objectKey);
      await recordAttachment(db, row({ source: "attach" }));
      expect((await attachmentRow(db, "acme", row().objectKey))?.detachedAt).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("is a no-op on a key with no row", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      await detachAttachment(db, "acme", "gh/acme/web/pull/12/nope.png");
      await reattachAttachment(db, "acme", "gh/acme/web/pull/12/nope.png");
      expect(await attachmentRow(db, "acme", "gh/acme/web/pull/12/nope.png")).toBeNull();
    } finally {
      sqlite.close();
    }
  });
});

describe("attachment index deletes", () => {
  it("deleteAttachment removes exactly one row", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      await recordAttachment(db, row());
      await recordAttachment(db, row({ objectKey: "gh/acme/web/pull/12/two.png" }));
      await deleteAttachment(db, "acme", row().objectKey);
      expect(await attachmentRow(db, "acme", row().objectKey)).toBeNull();
      expect(await attachmentRow(db, "acme", "gh/acme/web/pull/12/two.png")).not.toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("deleteAttachmentsForKeys chunks past D1's 100-bound-parameter cap", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      const keys = Array.from({ length: 250 }, (_, i) => `gh/acme/web/pull/12/f${i}.png`);
      for (const objectKey of keys) await recordAttachment(db, row({ objectKey }));
      await recordAttachment(db, row({ objectKey: "gh/acme/web/pull/12/keep.png" }));

      await deleteAttachmentsForKeys(db, "acme", keys);

      const remaining = await db
        .prepare("SELECT COUNT(*) AS count FROM github_attachments")
        .bind()
        .first<{ count: number }>();
      expect(remaining?.count).toBe(1);
      expect(await attachmentRow(db, "acme", "gh/acme/web/pull/12/keep.png")).not.toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("deleteAttachmentsForKeys is a no-op on an empty list", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      await recordAttachment(db, row());
      await deleteAttachmentsForKeys(db, "acme", []);
      expect(await attachmentRow(db, "acme", row().objectKey)).not.toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("deleteAttachmentsForWorkspace clears one workspace only", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      await recordAttachment(db, row());
      await recordAttachment(db, row({ workspace: "other" }));
      await deleteAttachmentsForWorkspace(db, "acme");
      expect(await attachmentRow(db, "acme", row().objectKey)).toBeNull();
      expect(await attachmentRow(db, "other", row().objectKey)).not.toBeNull();
    } finally {
      sqlite.close();
    }
  });
});
