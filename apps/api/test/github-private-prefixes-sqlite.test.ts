/// <reference types="node" />

import { describe, expect, it } from "vitest";
import {
  generatePrefixId,
  getActivePrefixId,
  getOrMintPrefixId,
  listActivePrefixIds,
  listPrefixIdsForTarget,
  PREFIX_IDS_FOR_TARGET_SQL,
  PRIVATE_PREFIX_ID_RE,
  repoForPrefixId,
  retirePrefixId,
} from "../src/github-private-prefixes";
import { recordAttachment } from "../src/github-attachment-index";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const MIGRATIONS = ["migrations/20260811210000_github_private_prefixes.sql"];

describe("generatePrefixId / PRIVATE_PREFIX_ID_RE", () => {
  it("returns a 32-char lowercase hex id matching the regex", () => {
    const id = generatePrefixId();
    expect(id).toMatch(PRIVATE_PREFIX_ID_RE);
    expect(id).toHaveLength(32);
  });

  it("returns different ids on successive calls", () => {
    expect(generatePrefixId()).not.toBe(generatePrefixId());
  });
});

describe("github private prefixes persistence against SQLite", () => {
  it("mints a 32-hex id for a fresh (repo, branch)", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const id = await getOrMintPrefixId(database(sqlite), "Acme/Web", "main");
      expect(id).toMatch(PRIVATE_PREFIX_ID_RE);
    } finally {
      sqlite.close();
    }
  });

  it("is idempotent: a second mint call returns the same id", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      const first = await getOrMintPrefixId(db, "acme/web", "main");
      const second = await getOrMintPrefixId(db, "acme/web", "main");
      expect(second).toBe(first);
    } finally {
      sqlite.close();
    }
  });

  it("distinct branches get distinct ids", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      const main = await getOrMintPrefixId(db, "acme/web", "main");
      const feature = await getOrMintPrefixId(db, "acme/web", "feature-x");
      expect(main).not.toBe(feature);
    } finally {
      sqlite.close();
    }
  });

  it("the '' branch (repo-level sentinel) works", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      const id = await getOrMintPrefixId(db, "acme/web", "");
      expect(id).toMatch(PRIVATE_PREFIX_ID_RE);
      await expect(getActivePrefixId(db, "acme/web", "")).resolves.toBe(id);
    } finally {
      sqlite.close();
    }
  });

  it("getActivePrefixId returns null when nothing has been minted", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      await expect(getActivePrefixId(database(sqlite), "acme/web", "main")).resolves.toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("lowercases repo and branch on the way in", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      const id = await getOrMintPrefixId(db, "Acme/Web", "Main");
      await expect(getActivePrefixId(db, "acme/web", "main")).resolves.toBe(id);
      await expect(getActivePrefixId(db, "ACME/WEB", "MAIN")).resolves.toBe(id);
    } finally {
      sqlite.close();
    }
  });

  it("listActivePrefixIds returns ids across branches and excludes retired ones", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      const main = await getOrMintPrefixId(db, "acme/web", "main");
      const feature = await getOrMintPrefixId(db, "acme/web", "feature-x");
      const repoLevel = await getOrMintPrefixId(db, "acme/web", "");
      await retirePrefixId(db, "acme/web", "feature-x", feature);

      const ids = await listActivePrefixIds(db, "acme/web");
      expect(new Set(ids)).toEqual(new Set([main, repoLevel]));
      expect(ids).not.toContain(feature);
    } finally {
      sqlite.close();
    }
  });

  it("retirePrefixId then getOrMintPrefixId mints a fresh, different id", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      const original = await getOrMintPrefixId(db, "acme/web", "main");
      await retirePrefixId(db, "acme/web", "main", original);
      const rotated = await getOrMintPrefixId(db, "acme/web", "main");
      expect(rotated).not.toBe(original);
      expect(rotated).toMatch(PRIVATE_PREFIX_ID_RE);
    } finally {
      sqlite.close();
    }
  });

  it("the partial unique index enforces one active row per (repo, branch): two mints under contention converge on one id", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      const [a, b] = await Promise.all([
        getOrMintPrefixId(db, "acme/web", "main"),
        getOrMintPrefixId(db, "acme/web", "main"),
      ]);
      expect(a).toBe(b);
      const ids = await listActivePrefixIds(db, "acme/web");
      expect(ids).toEqual([a]);
    } finally {
      sqlite.close();
    }
  });
});

describe("repoForPrefixId", () => {
  it("returns the lowercased repo that minted the id", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      const id = await getOrMintPrefixId(db, "Acme/Web", "main");
      expect(await repoForPrefixId(db, id)).toBe("acme/web");
    } finally {
      sqlite.close();
    }
  });

  it("still resolves after the id is retired", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      const id = await getOrMintPrefixId(db, "acme/web", "main");
      await retirePrefixId(db, "acme/web", "main", id);
      expect(await repoForPrefixId(db, id)).toBe("acme/web");
    } finally {
      sqlite.close();
    }
  });

  it("returns null for an unknown id", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      expect(await repoForPrefixId(database(sqlite), "f".repeat(32))).toBeNull();
    } finally {
      sqlite.close();
    }
  });
});

describe("listPrefixIdsForTarget against SQLite", () => {
  const WITH_INDEX = [
    ...MIGRATIONS,
    "migrations/20260903120000_github_attachments.sql",
    "migrations/20261027120000_github_attachments_size.sql",
  ];
  const target = { kind: "pull" as const, num: 12 };

  it("reads the attachment target index, not a workspace-wide scan", () => {
    const sqlite = new SqliteD1(WITH_INDEX);
    try {
      const plan = (
        sqlite.db
          .prepare(`EXPLAIN QUERY PLAN ${PREFIX_IDS_FOR_TARGET_SQL}`)
          .all("acme", "acme/web", "pull", 12) as Array<{ detail: string }>
      )
        .map((row) => row.detail)
        .join("\n");
      expect(plan).toContain("USING INDEX github_attachments_target_idx");
    } finally {
      sqlite.close();
    }
  });

  it("returns ids from this target's attached rows plus the sentinel and head branch", async () => {
    const sqlite = new SqliteD1(WITH_INDEX);
    const db = database(sqlite);
    try {
      const used = await getOrMintPrefixId(db, "acme/web", "feature/shots");
      const detached = await getOrMintPrefixId(db, "acme/web", "feature/old");
      const otherRepo = await getOrMintPrefixId(db, "acme/api", "feature/a");
      const sentinel = await getOrMintPrefixId(db, "acme/web", "");
      const head = await getOrMintPrefixId(db, "acme/web", "main");
      await getOrMintPrefixId(db, "acme/web", "claude/unrelated");
      const row = (prefixId: string, repo: string, file: string) => ({
        workspace: "acme",
        repo,
        kind: "pull" as const,
        num: 12,
        objectKey: `gh/private/${prefixId}/pull/12/${file}`,
        prefixId,
        laneId: null,
        source: "put" as const,
      });
      await recordAttachment(db, row(used, "acme/web", "a.png"));
      await recordAttachment(db, row(used, "acme/web", "b.png"));
      await recordAttachment(db, row(otherRepo, "acme/api", "c.png"));
      await recordAttachment(db, row(detached, "acme/web", "d.png"));
      sqlite.db
        .prepare("UPDATE github_attachments SET detached_at = ? WHERE prefix_id = ?")
        .run("2026-11-06T00:00:00.000Z", detached);

      const ids = await listPrefixIdsForTarget(db, "acme", "Acme/Web", target, {
        headBranch: "main",
      });
      expect(ids).toEqual([used, sentinel, head].sort());
    } finally {
      sqlite.close();
    }
  });
});
