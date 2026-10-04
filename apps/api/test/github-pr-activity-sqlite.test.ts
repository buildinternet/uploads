/// <reference types="node" />

import { describe, expect, it } from "vitest";
import {
  applyPrActivityWebhook,
  backfillPrActivityState,
  countOpenPullsByRepo,
  listPrActivityForWorkspace,
  listPrActivityPage,
  recordPrActivityFromMetadata,
  recordPrMediaActivity,
} from "../src/github-pr-activity";
import { processWebhookEvent } from "../src/github-webhook";
import { FakeKv } from "./fake-kv";
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

const ROLLUP_MIGRATIONS = [
  "migrations/20260720120000_github_repo_links.sql",
  "migrations/20260721150000_github_pr_activity.sql",
  "migrations/20261004120100_pr_activity_title_state.sql",
];

function linkRepo(sqlite: SqliteD1, repo: string, workspace: string) {
  sqlite.db
    .prepare(
      `INSERT INTO github_repo_links (repo_full_name, workspace_name, installation_id, source, created_at)
       VALUES (?, ?, NULL, 'test', '2026-10-01T00:00:00.000Z')`,
    )
    .run(repo, workspace);
}

function rollup(sqlite: SqliteD1, ref: string) {
  return sqlite.db
    .prepare(`SELECT title, state, workspace_name FROM github_pr_activity WHERE ref = ?`)
    .get(ref) as { title: string | null; state: string | null; workspace_name: string } | undefined;
}

describe("PR rollup title/state", () => {
  it("pages newest first, breaks last_media_at ties by ref, and filters by repo and state", async () => {
    const sqlite = new SqliteD1(ROLLUP_MIGRATIONS);
    try {
      const db = database(sqlite);
      const t = (h: number) => new Date(Date.UTC(2026, 9, 1, h));
      await recordPrMediaActivity(
        db,
        { repo: "acme/web", prNumber: 1, workspaceName: "acme", count: 1 },
        t(1),
      );
      await recordPrMediaActivity(
        db,
        { repo: "acme/web", prNumber: 2, workspaceName: "acme", count: 1 },
        t(2),
      );
      await recordPrMediaActivity(
        db,
        { repo: "acme/web", prNumber: 3, workspaceName: "acme", count: 1 },
        t(2),
      );
      await recordPrMediaActivity(
        db,
        { repo: "acme/api", prNumber: 4, workspaceName: "acme", count: 1 },
        t(0),
      );
      await recordPrMediaActivity(
        db,
        { repo: "acme/zzz", prNumber: 9, workspaceName: "beta", count: 1 },
        t(5),
      );
      sqlite.db
        .prepare(`UPDATE github_pr_activity SET state = 'merged' WHERE ref = 'acme/web#1'`)
        .run();
      sqlite.db
        .prepare(`UPDATE github_pr_activity SET state = 'open' WHERE ref = 'acme/web#2'`)
        .run();

      const first = await listPrActivityPage(db, "acme", { limit: 2 });
      expect(first.rows.map((r) => r.ref)).toEqual(["acme/web#2", "acme/web#3"]);
      expect(first.rows[0]).toMatchObject({ state: "open", title: null, prNumber: 2 });
      expect(first.nextCursor).toEqual({ updatedAt: t(2).toISOString(), key: "acme/web#3" });
      const second = await listPrActivityPage(db, "acme", { limit: 2, cursor: first.nextCursor });
      expect(second.rows.map((r) => r.ref)).toEqual(["acme/web#1", "acme/api#4"]);
      expect(second.nextCursor).toBeNull();

      const open = await listPrActivityPage(db, "acme", { limit: 20, state: "open" });
      expect(open.rows.map((r) => r.ref)).toEqual(["acme/web#2"]);
      const api = await listPrActivityPage(db, "acme", { limit: 20, repo: "acme/api" });
      expect(api.rows.map((r) => r.ref)).toEqual(["acme/api#4"]);
    } finally {
      sqlite.close();
    }
  });

  it("keeps only rows at or after `since` and pages inside that window", async () => {
    const sqlite = new SqliteD1(ROLLUP_MIGRATIONS);
    try {
      const db = database(sqlite);
      const t = (h: number) => new Date(Date.UTC(2026, 9, 1, h));
      await recordPrMediaActivity(
        db,
        { repo: "acme/web", prNumber: 1, workspaceName: "acme", count: 1 },
        t(1),
      );
      await recordPrMediaActivity(
        db,
        { repo: "acme/web", prNumber: 2, workspaceName: "acme", count: 1 },
        t(2),
      );
      await recordPrMediaActivity(
        db,
        { repo: "acme/web", prNumber: 3, workspaceName: "acme", count: 1 },
        t(3),
      );

      const since = t(2).toISOString();
      const first = await listPrActivityPage(db, "acme", { limit: 1, since });
      expect(first.rows.map((r) => r.ref)).toEqual(["acme/web#3"]);
      const second = await listPrActivityPage(db, "acme", {
        limit: 1,
        since,
        cursor: first.nextCursor,
      });
      expect(second.rows.map((r) => r.ref)).toEqual(["acme/web#2"]); // boundary row is kept
      expect(second.nextCursor).toBeNull(); // #1 is before the window
    } finally {
      sqlite.close();
    }
  });

  it("applies webhook title/state to a linked row, lowercases the ref, and never inserts", async () => {
    const sqlite = new SqliteD1(ROLLUP_MIGRATIONS);
    try {
      const db = database(sqlite);
      await recordPrMediaActivity(db, {
        repo: "acme/web",
        prNumber: 7,
        workspaceName: "acme",
        count: 1,
      });
      linkRepo(sqlite, "acme/web", "acme");

      await applyPrActivityWebhook(db, {
        repo: "Acme/Web",
        number: 7,
        title: "Fix login",
        state: "merged",
      });
      expect(rollup(sqlite, "acme/web#7")).toMatchObject({ title: "Fix login", state: "merged" });

      await applyPrActivityWebhook(db, {
        repo: "acme/web",
        number: 8,
        title: "No media",
        state: "open",
      });
      expect(rollup(sqlite, "acme/web#8")).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });

  it("does not write a title into a row another workspace fabricated (review focus 3)", async () => {
    const sqlite = new SqliteD1(ROLLUP_MIGRATIONS);
    try {
      const db = database(sqlite);
      // mallory tagged an upload gh.repo=acme/secret, gh.number=1; acme owns the repo link.
      await recordPrMediaActivity(db, {
        repo: "acme/secret",
        prNumber: 1,
        workspaceName: "mallory",
        count: 1,
      });
      linkRepo(sqlite, "acme/secret", "acme");

      await applyPrActivityWebhook(db, {
        repo: "acme/secret",
        number: 1,
        title: "Secret plan",
        state: "open",
      });
      expect(rollup(sqlite, "acme/secret#1")).toMatchObject({
        workspace_name: "mallory",
        title: null,
        state: null,
      });
    } finally {
      sqlite.close();
    }
  });

  it("backfills title/state, skipping invalid states, and counts open PRs per repo", async () => {
    const sqlite = new SqliteD1(ROLLUP_MIGRATIONS);
    try {
      const db = database(sqlite);
      for (const n of [1, 2, 3]) {
        await recordPrMediaActivity(db, {
          repo: "acme/web",
          prNumber: n,
          workspaceName: "acme",
          count: 1,
        });
      }
      await recordPrMediaActivity(db, {
        repo: "acme/api",
        prNumber: 4,
        workspaceName: "acme",
        count: 1,
      });
      await backfillPrActivityState(db, [
        { ref: "acme/web#1", title: "One", state: "open" },
        { ref: "acme/web#2", title: "Two", state: "open" },
        { ref: "acme/web#3", title: "Three", state: "draft" },
        { ref: "acme/api#4", title: "Four", state: "closed" },
      ]);
      expect(rollup(sqlite, "acme/web#1")).toMatchObject({ title: "One", state: "open" });
      expect(rollup(sqlite, "acme/web#3")).toMatchObject({ title: null, state: null });

      const counts = await countOpenPullsByRepo(db, "acme", ["acme/web", "acme/api", "acme/none"]);
      expect(Object.fromEntries(counts)).toEqual({ "acme/web": 2 });
      expect((await countOpenPullsByRepo(db, "acme", [])).size).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it("processWebhookEvent writes a prActivity event through to D1", async () => {
    const sqlite = new SqliteD1(ROLLUP_MIGRATIONS);
    try {
      const db = database(sqlite);
      await recordPrMediaActivity(db, {
        repo: "acme/web",
        prNumber: 5,
        workspaceName: "acme",
        count: 1,
      });
      linkRepo(sqlite, "acme/web", "acme");
      const env = { DB: db, GITHUB_CACHE: new FakeKv() } as unknown as Env;
      await processWebhookEvent(env, {
        keys: [],
        prActivity: { repo: "acme/web", number: 5, title: "Ship it", state: "closed" },
      });
      expect(rollup(sqlite, "acme/web#5")).toMatchObject({ title: "Ship it", state: "closed" });
    } finally {
      sqlite.close();
    }
  });
});
