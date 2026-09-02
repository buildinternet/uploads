/// <reference types="node" />

import { describe, expect, it, vi } from "vitest";
import {
  attachmentRow,
  deleteAttachment,
  deleteAttachmentSafe,
  deleteAttachmentsForKeys,
  deleteAttachmentsForKeysSafe,
  deleteAttachmentsForWorkspace,
  deleteAttachmentsForWorkspaceSafe,
  detachAttachment,
  detachAttachmentSafe,
  parseAttachmentKey,
  reattachAttachment,
  reattachAttachmentSafe,
  recordAttachment,
  recordAttachmentForKeySafe,
  recordAttachmentSafe,
  rekeyAttachment,
  rekeyAttachmentSafe,
} from "../src/github-attachment-index";
import { getOrMintPrefixId } from "../src/github-private-prefixes";
import { database, SqliteD1 } from "./helpers/sqlite-d1";

const MIGRATIONS = ["migrations/20260903120000_github_attachments.sql"];

const MIGRATIONS_WITH_PREFIXES = [
  "migrations/20260903120000_github_attachments.sql",
  "migrations/20260811210000_github_private_prefixes.sql",
];

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

  it("falls through to the plain parse for an owner literally named 'private'", () => {
    expect(parseAttachmentKey("gh/private/web/pull/12/x.png")).toEqual({
      kind: "pull",
      num: 12,
      prefixId: null,
      repo: "private/web",
    });
    const id = "f".repeat(32);
    expect(parseAttachmentKey(`gh/private/${id}/pull/12/hero.png`)).toEqual({
      kind: "pull",
      num: 12,
      prefixId: id,
      repo: null,
    });
    expect(parseAttachmentKey(`gh/private/${"g".repeat(32)}/branch/x.png`)).toBeUndefined();
  });

  it("returns undefined for branch-staged, malformed, and non-gh keys", () => {
    expect(parseAttachmentKey("gh/acme/web/branch/feat-x/hero.png")).toBeUndefined();
    expect(parseAttachmentKey(`gh/private/${"c".repeat(32)}/branch/hero.png`)).toBeUndefined();
    expect(parseAttachmentKey("gh/acme/web/pull/0/hero.png")).toBeUndefined();
    expect(parseAttachmentKey("gh/acme/web/pull/12/")).toBeUndefined();
    expect(parseAttachmentKey("gh/acme/web/pull/abc/hero.png")).toBeUndefined();
    expect(parseAttachmentKey("f/abc/hero.png")).toBeUndefined();
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

  it("recordAttachment clears a previously-set detached_at for a non-put source", async () => {
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

  it("recordAttachment leaves detached_at untouched for a 'put' re-record", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      await recordAttachment(db, row());
      await detachAttachment(db, "acme", row().objectKey, new Date("2026-09-05T00:00:00.000Z"));
      await recordAttachment(db, row({ source: "put" }));
      expect((await attachmentRow(db, "acme", row().objectKey))?.detachedAt).toBe(
        "2026-09-05T00:00:00.000Z",
      );
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

describe("rekeyAttachment", () => {
  it("moves a row to the new key and prefix id", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      const oldId = "a".repeat(32);
      const newId = "b".repeat(32);
      const fromKey = `gh/private/${oldId}/pull/12/hero.png`;
      const toKey = `gh/private/${newId}/pull/12/hero.png`;
      await recordAttachment(
        db,
        row({ objectKey: fromKey, prefixId: oldId, laneId: "lane-a", source: "attach" }),
      );

      await rekeyAttachment(
        db,
        "acme",
        fromKey,
        toKey,
        newId,
        "lane-b",
        new Date("2026-09-07T00:00:00.000Z"),
      );

      expect(await attachmentRow(db, "acme", fromKey)).toBeNull();
      expect(await attachmentRow(db, "acme", toKey)).toMatchObject({
        prefixId: newId,
        laneId: "lane-b",
        updatedAt: "2026-09-07T00:00:00.000Z",
        source: "attach",
      });
    } finally {
      sqlite.close();
    }
  });

  it("wipes an already-occupied destination row before the update", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      const oldId = "a".repeat(32);
      const newId = "b".repeat(32);
      const fromKey = `gh/private/${oldId}/pull/12/hero.png`;
      const toKey = `gh/private/${newId}/pull/12/hero.png`;
      // putObject already wrote a row at the destination during rotation.
      await recordAttachment(db, row({ objectKey: toKey, prefixId: newId, source: "put" }));
      await recordAttachment(db, row({ objectKey: fromKey, prefixId: oldId, laneId: "lane-a" }));

      await rekeyAttachment(db, "acme", fromKey, toKey, newId, "lane-b");

      expect(await attachmentRow(db, "acme", fromKey)).toBeNull();
      const dest = await attachmentRow(db, "acme", toKey);
      expect(dest).toMatchObject({ prefixId: newId, laneId: "lane-b", source: "put" });
      const count = await db
        .prepare("SELECT COUNT(*) AS count FROM github_attachments")
        .bind()
        .first<{ count: number }>();
      expect(count?.count).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it("is a no-op when the source key has no row", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      await rekeyAttachment(
        db,
        "acme",
        "gh/acme/web/pull/12/a.png",
        "gh/acme/web/pull/12/b.png",
        null,
        null,
      );
      expect(await attachmentRow(db, "acme", "gh/acme/web/pull/12/b.png")).toBeNull();
    } finally {
      sqlite.close();
    }
  });
});

describe("attachment index safe writers", () => {
  const throwingDb = {
    prepare: () => ({
      bind: () => ({
        run: async () => {
          throw new Error("D1 exploded");
        },
        first: async () => {
          throw new Error("D1 exploded");
        },
        all: async () => {
          throw new Error("D1 exploded");
        },
      }),
    }),
    batch: async () => [],
  } as unknown as Parameters<typeof recordAttachment>[0];

  it("swallow D1 failures and log a JSON line", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((msg) => {
      errors.push(String(msg));
    });
    try {
      await recordAttachmentSafe(throwingDb, row());
      await detachAttachmentSafe(throwingDb, "acme", row().objectKey);
      await reattachAttachmentSafe(throwingDb, "acme", row().objectKey);
      await deleteAttachmentSafe(throwingDb, "acme", row().objectKey);
      await deleteAttachmentsForKeysSafe(throwingDb, "acme", [row().objectKey]);
      await deleteAttachmentsForWorkspaceSafe(throwingDb, "acme");
      await rekeyAttachmentSafe(throwingDb, "acme", "a", "b", null, null);
    } finally {
      spy.mockRestore();
    }
    expect(errors).toHaveLength(7);
    for (const line of errors) {
      const parsed = JSON.parse(line) as { message: string; error: string };
      expect(parsed.message).toContain("attachment index");
      expect(parsed.error).toBe("D1 exploded");
    }
  });

  it("recordAttachmentForKeySafe swallows a throwing db for both a private and a plain key", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((msg) => {
      errors.push(String(msg));
    });
    try {
      // Private key: needs a `repoForPrefixId` D1 lookup before the write,
      // and that lookup itself throws.
      await recordAttachmentForKeySafe(throwingDb, {
        workspace: "acme",
        objectKey: `gh/private/${"a".repeat(32)}/pull/12/hero.png`,
        source: "put",
        laneId: null,
      });
      // Plain key: no D1 lookup needed before the write, so only the
      // write itself throws.
      await recordAttachmentForKeySafe(throwingDb, {
        workspace: "acme",
        objectKey: "gh/acme/web/pull/12/hero.png",
        source: "put",
        laneId: null,
      });
    } finally {
      spy.mockRestore();
    }
    expect(errors).toHaveLength(2);
    for (const line of errors) {
      const parsed = JSON.parse(line) as { message: string; error: string };
      expect(parsed.message).toContain("attachment index");
    }
  });
});

describe("recordAttachmentForKeySafe", () => {
  it("derives repo/kind/num from a plain key", async () => {
    const sqlite = new SqliteD1(MIGRATIONS_WITH_PREFIXES);
    try {
      const db = database(sqlite);
      await recordAttachmentForKeySafe(db, {
        workspace: "acme",
        objectKey: "gh/Acme/Web/pull/12/hero.png",
        source: "put",
        laneId: null,
      });
      expect(await attachmentRow(db, "acme", "gh/Acme/Web/pull/12/hero.png")).toMatchObject({
        repo: "acme/web",
        kind: "pull",
        num: 12,
        prefixId: null,
        source: "put",
      });
    } finally {
      sqlite.close();
    }
  });

  it("resolves a private key's repo from the prefix id's owning row", async () => {
    const sqlite = new SqliteD1(MIGRATIONS_WITH_PREFIXES);
    try {
      const db = database(sqlite);
      const id = await getOrMintPrefixId(db, "acme/web", "feat-x");
      const key = `gh/private/${id}/pull/12/hero.png`;
      await recordAttachmentForKeySafe(db, {
        workspace: "acme",
        objectKey: key,
        source: "put",
        laneId: "lane-a",
      });
      expect(await attachmentRow(db, "acme", key)).toMatchObject({
        repo: "acme/web",
        prefixId: id,
        laneId: "lane-a",
      });
    } finally {
      sqlite.close();
    }
  });

  it("prefers the caller's server-resolved repo over the key's sanitized spelling", async () => {
    const sqlite = new SqliteD1(MIGRATIONS_WITH_PREFIXES);
    try {
      const db = database(sqlite);
      await recordAttachmentForKeySafe(db, {
        workspace: "acme",
        objectKey: "gh/acme/we-b/pull/12/hero.png",
        source: "attach",
        laneId: null,
        repo: "Acme/we.b",
      });
      expect((await attachmentRow(db, "acme", "gh/acme/we-b/pull/12/hero.png"))?.repo).toBe(
        "acme/we.b",
      );
    } finally {
      sqlite.close();
    }
  });

  it("writes nothing for a non-attachment key or an unresolvable private repo", async () => {
    const sqlite = new SqliteD1(MIGRATIONS_WITH_PREFIXES);
    try {
      const db = database(sqlite);
      await recordAttachmentForKeySafe(db, {
        workspace: "acme",
        objectKey: "f/abc/hero.png",
        source: "put",
        laneId: null,
      });
      const orphanKey = `gh/private/${"e".repeat(32)}/pull/12/hero.png`;
      await recordAttachmentForKeySafe(db, {
        workspace: "acme",
        objectKey: orphanKey,
        source: "put",
        laneId: null,
      });
      const count = await db
        .prepare("SELECT COUNT(*) AS count FROM github_attachments")
        .bind()
        .first<{ count: number }>();
      expect(count?.count).toBe(0);
    } finally {
      sqlite.close();
    }
  });
});
