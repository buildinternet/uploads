import { describe, expect, it } from "vitest";
import { database, SqliteD1 } from "../test/helpers/sqlite-d1";
import { loadDigestSources } from "./weekly-digest-data";
import { runWeeklyDigestSweep } from "./weekly-digest-sweep";

const MIGRATIONS = [
  "migrations/20260710140000_workspace_usage.sql",
  "migrations/20260711180000_galleries.sql",
  "migrations/20260713210559_file_metadata.sql",
  "migrations/20260721150000_github_pr_activity.sql",
  "migrations/20260728120000_daily_metrics.sql",
  "migrations/20260822120000_auth_tables.sql",
  "migrations/20260829120000_auth_user_notify_member_join.sql",
  "migrations/20260829130000_auth_user_notify_usage_limits.sql",
  "migrations/20260903120000_github_attachments.sql",
  "migrations/20260915120000_feeds.sql",
  "migrations/20261004120100_pr_activity_title_state.sql",
  "migrations/20261007120000_client_activity.sql",
  "migrations/20261012140000_auth_user_weekly_digest.sql",
];

const NOW = new Date("2026-10-12T14:00:00.000Z");
const RECENT = "2026-10-11T12:00:00.000Z";
const OLD = "2026-09-01T00:00:00.000Z";

function registry(records: Record<string, unknown>) {
  const markers = new Map<string, string>();
  return {
    markers,
    get: (async (key: string) => {
      if (key.startsWith("ws:")) return records[key] ?? null;
      return markers.get(key) ?? null;
    }) as unknown as KVNamespace["get"],
    async put(key: string, value: string) {
      markers.set(key, value);
    },
    async list({ prefix }: { prefix?: string }) {
      return {
        keys: [...markers.keys()]
          .filter((name) => !prefix || name.startsWith(prefix))
          .map((name) => ({ name })),
        list_complete: true,
        cursor: "",
      };
    },
  };
}

describe("loadDigestSources", () => {
  it("collects the week's files, repos, shots, pages, and admin activity", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = sqlite.db;
      db.prepare(
        `INSERT INTO daily_metrics (metric, day, workspace, count, bytes) VALUES ('upload', '2026-10-11', 'acme', 4, 2500000)`,
      ).run();
      db.prepare(
        `INSERT INTO daily_metrics (metric, day, workspace, count, bytes) VALUES ('upload', '2026-09-01', 'acme', 99, 999)`,
      ).run();
      db.prepare(
        `INSERT INTO github_pr_activity
           (ref, repo_full_name, pr_number, branch, workspace_name, media_count, first_media_at, last_media_at, title, state)
         VALUES ('acme/web#12', 'acme/web', 12, 'digest', 'acme', 3, ?, ?, 'Weekly mail', 'open')`,
      ).run(RECENT, RECENT);
      db.prepare(
        `INSERT INTO github_attachments
           (workspace, repo, kind, num, object_key, source, created_at, updated_at)
         VALUES ('acme', 'acme/web', 'issues', 4, 'gh/acme/web/issues/4/note.png', 'attach', ?, ?)`,
      ).run(RECENT, RECENT);
      db.prepare(
        `INSERT INTO file_metadata (workspace, object_key, meta_key, meta_value, updated_at)
         VALUES ('acme', 'shots/settings.png', 'path', '/settings', ?)`,
      ).run(RECENT);
      db.prepare(
        `INSERT INTO file_metadata (workspace, object_key, meta_key, meta_value, updated_at)
         VALUES ('acme', 'shots/old.png', 'path', '/old', ?)`,
      ).run(OLD);
      db.prepare(
        `INSERT INTO galleries (id, workspace, title, created_at, updated_at)
         VALUES ('g1', 'acme', 'Launch', ?, ?)`,
      ).run(RECENT, RECENT);
      db.prepare(
        `INSERT INTO feeds (id, workspace, repo, path, created_at, updated_at)
         VALUES ('f1', 'acme', 'acme/web', '', ?, ?)`,
      ).run(RECENT, RECENT);
      db.prepare(
        `INSERT INTO workspace_usage (workspace, bytes, objects, uploads_in_period, period_start, updated_at)
         VALUES ('acme', 8000, 6, 4, '2026-10', ?)`,
      ).run(RECENT);
      db.prepare(
        `INSERT INTO organization (id, name, slug, created_at) VALUES ('org', 'Acme', 'acme', 1)`,
      ).run();
      db.prepare(
        `INSERT INTO user (id, name, email, created_at, updated_at) VALUES ('new', 'New', 'new@example.com', 1, 1)`,
      ).run();
      const joined = Math.floor(new Date(RECENT).getTime() / 1000);
      db.prepare(
        `INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ('m1', 'org', 'new', 'member', ?)`,
      ).run(joined);
      db.prepare(
        `INSERT INTO client_activity
           (workspace, principal, surface, user_id, first_seen_at, last_seen_at)
         VALUES ('acme', 'user:new', 'cli', 'new', ?, ?)`,
      ).run(RECENT, RECENT);

      const kv = registry({
        "ws:acme": {
          provider: "r2",
          bucket: "uploads-default",
          publicBaseUrl: "https://storage.uploads.sh",
          prefix: "acme/",
        },
      });
      const sources = await loadDigestSources(database(sqlite), kv, NOW);
      const acme = sources.get("acme");
      expect(acme?.uploads).toBe(4);
      expect(acme?.bytesAdded).toBe(2_500_000);
      expect(acme?.pulls[0]).toMatchObject({ repo: "acme/web", number: 12, title: "Weekly mail" });
      expect(acme?.issues[0]).toMatchObject({ repo: "acme/web", number: 4 });
      expect(acme?.repos.some((repo) => repo.name === "acme/web")).toBe(true);
      expect(acme?.pages.map((page) => page.path)).toEqual(["/settings"]);
      expect(acme?.galleryNames).toEqual(["Launch"]);
      expect(acme?.feeds).toBe(1);
      expect(acme?.newMembers).toBe(1);
      expect(acme?.activePeople).toBe(1);
      expect(acme?.uploadsThisMonth).toBe(4);
      expect(acme?.shots.map((shot) => shot.label)).toContain("/settings");
      expect(acme?.shots.find((shot) => shot.label === "/settings")?.url).toBe(
        "https://storage.uploads.sh/acme/shots/settings.png",
      );
      expect(acme?.shots.find((shot) => shot.label === "/settings")?.embedUrl).toContain(
        "embed.uploads.sh",
      );
      expect(acme?.shots.some((shot) => shot.label === "/old")).toBe(false);
    } finally {
      sqlite.close();
    }
  });
});

describe("runWeeklyDigestSweep", () => {
  it("posts one digest for an opted-in member and does not send it again the same week", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      sqlite.db
        .prepare(
          `INSERT INTO daily_metrics (metric, day, workspace, count, bytes) VALUES ('upload', '2026-10-11', 'acme', 2, 1000)`,
        )
        .run();
      sqlite.db
        .prepare(
          `INSERT INTO organization (id, name, slug, created_at) VALUES ('org', 'Acme', 'acme', 1)`,
        )
        .run();
      sqlite.db
        .prepare(
          `INSERT INTO user (id, name, email, created_at, updated_at, notify_weekly_digest)
           VALUES ('ada', 'Ada', 'ada@example.com', 1, 1, 1)`,
        )
        .run();
      sqlite.db
        .prepare(
          `INSERT INTO user (id, name, email, created_at, updated_at)
           VALUES ('quiet', 'Quiet', 'quiet@example.com', 1, 1)`,
        )
        .run();
      sqlite.db
        .prepare(
          `INSERT INTO member (id, organization_id, user_id, role, created_at)
           VALUES ('m-ada', 'org', 'ada', 'member', 1), ('m-quiet', 'org', 'quiet', 'member', 1)`,
        )
        .run();

      const posts: { userId: string }[][] = [];
      const kv = registry({});
      const env = {
        REGISTRY: kv,
        DB: database(sqlite),
        AUTH: {
          fetch: async (_url: string, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body)) as { messages: { userId: string }[] };
            posts.push(body.messages);
            return new Response(
              JSON.stringify({ sent: body.messages.map((message) => message.userId), failed: [] }),
              { status: 200 },
            );
          },
        },
      };

      const first = await runWeeklyDigestSweep(env as unknown as Env, {
        now: NOW,
        db: database(sqlite),
      });
      expect(first.sent).toBe(1);
      expect(posts).toHaveLength(1);
      expect(posts[0]?.map((message) => message.userId)).toEqual(["ada"]);

      const second = await runWeeklyDigestSweep(env as unknown as Env, {
        now: NOW,
        db: database(sqlite),
      });
      expect(second.sent).toBe(0);
      expect(second.skipped).toBe(1);
      expect(posts).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  it("does not post when the opted-in member's workspace was quiet", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      sqlite.db
        .prepare(
          `INSERT INTO organization (id, name, slug, created_at) VALUES ('org', 'Acme', 'acme', 1)`,
        )
        .run();
      sqlite.db
        .prepare(
          `INSERT INTO user (id, name, email, created_at, updated_at, notify_weekly_digest)
           VALUES ('ada', 'Ada', 'ada@example.com', 1, 1, 1)`,
        )
        .run();
      sqlite.db
        .prepare(
          `INSERT INTO member (id, organization_id, user_id, role, created_at)
           VALUES ('m-ada', 'org', 'ada', 'member', 1)`,
        )
        .run();
      let called = false;
      const env = {
        REGISTRY: registry({}),
        AUTH: {
          fetch: async () => {
            called = true;
            return new Response("{}", { status: 200 });
          },
        },
      };
      const result = await runWeeklyDigestSweep(env as unknown as Env, {
        now: NOW,
        db: database(sqlite),
      });
      expect(result.sent).toBe(0);
      expect(result.recipients).toBe(0);
      expect(called).toBe(false);
    } finally {
      sqlite.close();
    }
  });
});
