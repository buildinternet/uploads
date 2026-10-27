import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { digestDeliveryId, type WeeklyDigestMessage } from "@uploads/email";
import { describe, expect, it } from "vitest";
import { database, SqliteD1 } from "../test/helpers/sqlite-d1";
import { hasAdminPulse } from "./weekly-digest";
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
  "migrations/20261027120000_github_attachments_size.sql",
  "migrations/20260915120000_feeds.sql",
  "migrations/20261004120100_pr_activity_title_state.sql",
  "migrations/20261007120000_client_activity.sql",
  "migrations/20261012140000_auth_user_weekly_digest.sql",
  "migrations/20261012150000_auth_member_weekly_digest.sql",
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
  it("collects this week, the previous week, shots, and a storage-only pulse", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = sqlite.db;
      db.prepare(
        `INSERT INTO daily_metrics (metric, day, workspace, count, bytes) VALUES
           ('upload', '2026-10-11', 'acme', 4, 2500000),
           ('upload', '2026-10-04', 'acme', 7, 100),
           ('delete', '2026-10-11', 'acme', 1, 400),
           ('upload', '2026-09-01', 'acme', 99, 999)`,
      ).run();
      db.prepare(
        `INSERT INTO github_pr_activity
           (ref, repo_full_name, pr_number, branch, workspace_name, media_count, first_media_at, last_media_at, title, state)
         VALUES ('acme/web#12', 'acme/web', 12, 'digest', 'acme', 3, ?, ?, 'Weekly mail', 'open')`,
      ).run(RECENT, RECENT);
      db.prepare(
        `INSERT INTO github_attachments
           (workspace, repo, kind, num, object_key, source, created_at, updated_at)
         VALUES
           ('acme', 'acme/web', 'pull', 12, 'gh/acme/web/pull/12/review.png', 'attach', ?, ?),
           ('acme', 'acme/web', 'issues', 4, 'gh/acme/web/issues/4/note.png', 'attach', ?, ?)`,
      ).run(RECENT, RECENT, RECENT, RECENT);
      db.prepare(
        `INSERT INTO github_attachments
           (workspace, repo, kind, num, object_key, source, created_at, updated_at)
         VALUES ('acme', 'acme/web', 'pull', 2, 'gh/acme/web/pull/2/old.png', 'attach', ?, ?)`,
      ).run("2026-10-04T00:00:00.000Z", "2026-10-04T00:00:00.000Z");
      db.prepare(
        `INSERT INTO file_metadata (workspace, object_key, meta_key, meta_value, updated_at)
         VALUES ('acme', 'shots/settings.png', 'path', '/settings', ?)`,
      ).run(RECENT);
      db.prepare(
        `INSERT INTO file_metadata (workspace, object_key, meta_key, meta_value, updated_at)
         VALUES ('acme', 'shots/old.png', 'path', '/old', ?)`,
      ).run(OLD);
      db.prepare(
        `INSERT INTO file_metadata (workspace, object_key, meta_key, meta_value, updated_at)
         VALUES ('acme', 'shots/settings.png', 'gh.uploader-id', 'new', ?)`,
      ).run(RECENT);
      db.prepare(
        `INSERT INTO workspace_usage (workspace, bytes, objects, uploads_in_period, period_start, updated_at)
         VALUES ('acme', 8000, 6, 4, '2026-10', ?), ('tight', 220000000, 1, 0, '2026-10', ?)`,
      ).run(RECENT, RECENT);
      db.prepare(
        `INSERT INTO organization (id, name, slug, created_at) VALUES ('org', 'Acme', 'acme', 1)`,
      ).run();
      db.prepare(
        `INSERT INTO user (id, name, email, created_at, updated_at) VALUES ('new', 'New', 'new@example.com', 1, 1)`,
      ).run();
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
          plan: "free",
        },
        "ws:tight": {
          provider: "r2",
          bucket: "uploads-default",
          publicBaseUrl: "https://storage.uploads.sh",
          prefix: "tight/",
          plan: "free",
        },
      });
      const sources = await loadDigestSources(database(sqlite), kv, NOW);
      const acme = sources.get("acme");
      expect(acme?.uploads).toBe(4);
      expect(acme?.prevUploads).toBe(7);
      expect(acme?.bytesAdded).toBe(2_500_000);
      expect(acme?.bytesDeleted).toBe(400);
      expect(acme?.pulls[0]).toMatchObject({
        repo: "acme/web",
        number: 12,
        title: "Weekly mail",
        state: "open",
        count: 1,
      });
      expect(acme?.pulls[0]?.shot?.url).toBe(
        "https://storage.uploads.sh/acme/gh/acme/web/pull/12/review.png",
      );
      expect(acme?.repos.find((repo) => repo.name === "acme/web")).toMatchObject({
        count: 2,
        prev: 1,
      });
      expect(acme?.activePeople).toBe(1);
      expect(acme?.newPeople).toBe(1);
      expect(acme?.firstUploads).toEqual({ count: 1, name: "New" });
      expect(acme?.storageBytes).toBe(8000);
      expect(acme?.storageLimitBytes).toBe(250_000_000);
      const settings = acme?.shots.find((shot) => shot.label === "/settings");
      expect(settings?.url).toBe("https://storage.uploads.sh/acme/shots/settings.png");
      expect(settings?.embedUrl).toContain("embed.uploads.sh");
      expect(acme?.shots.some((shot) => shot.label === "/old")).toBe(false);

      const tight = sources.get("tight");
      expect(tight?.uploads).toBe(0);
      expect(tight?.storageBytes).toBe(220_000_000);
      expect(tight?.storageLimitBytes).toBe(250_000_000);
      expect(tight && hasAdminPulse(tight)).toBe(true);
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
          `INSERT INTO user (id, name, email, created_at, updated_at)
           VALUES ('ada', 'Ada', 'ada@example.com', 1, 1)`,
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
          `INSERT INTO member (id, organization_id, user_id, role, created_at, notify_weekly_digest)
           VALUES ('m-ada', 'org', 'ada', 'member', 1, 1), ('m-quiet', 'org', 'quiet', 'member', 1, 0)`,
        )
        .run();

      const posts: { userId: string }[][] = [];
      const kv = registry({});
      const env = {
        REGISTRY: kv,
        DB: database(sqlite),
        AUTH: {
          fetch: async (_url: string, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body)) as { messages: WeeklyDigestMessage[] };
            posts.push(body.messages);
            return new Response(
              JSON.stringify({
                sent: body.messages.flatMap((message) => {
                  const id = digestDeliveryId(message);
                  return id ? [id] : [];
                }),
                failed: [],
              }),
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
          `INSERT INTO user (id, name, email, created_at, updated_at)
           VALUES ('ada', 'Ada', 'ada@example.com', 1, 1)`,
        )
        .run();
      sqlite.db
        .prepare(
          `INSERT INTO member (id, organization_id, user_id, role, created_at, notify_weekly_digest)
           VALUES ('m-ada', 'org', 'ada', 'member', 1, 1)`,
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

  it("sends only the workspace whose membership opted in", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      sqlite.db
        .prepare(
          `INSERT INTO daily_metrics (metric, day, workspace, count, bytes) VALUES
             ('upload', '2026-10-11', 'acme', 2, 1000),
             ('upload', '2026-10-11', 'beta', 4, 1000)`,
        )
        .run();
      sqlite.db
        .prepare(
          `INSERT INTO organization (id, name, slug, created_at) VALUES
             ('org-acme', 'Acme', 'acme', 1),
             ('org-beta', 'Beta', 'beta', 1)`,
        )
        .run();
      sqlite.db
        .prepare(
          `INSERT INTO user (id, name, email, created_at, updated_at)
           VALUES ('ada', 'Ada', 'ada@example.com', 1, 1)`,
        )
        .run();
      sqlite.db
        .prepare(
          `INSERT INTO member
             (id, organization_id, user_id, role, created_at, notify_weekly_digest, notify_weekly_workspace_digest)
           VALUES
             ('m-acme', 'org-acme', 'ada', 'owner', 1, 0, 1),
             ('m-beta', 'org-beta', 'ada', 'member', 1, 0, 1)`,
        )
        .run();

      const posts: WeeklyDigestMessage[][] = [];
      const env = {
        REGISTRY: registry({}),
        DB: database(sqlite),
        AUTH: {
          fetch: async (_url: string, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body)) as { messages: WeeklyDigestMessage[] };
            posts.push(body.messages);
            return new Response(
              JSON.stringify({
                sent: body.messages.flatMap((message) => {
                  const id = digestDeliveryId(message);
                  return id ? [id] : [];
                }),
                failed: [],
              }),
              { status: 200 },
            );
          },
        },
      };
      const result = await runWeeklyDigestSweep(env as unknown as Env, {
        now: NOW,
        db: database(sqlite),
      });
      expect(result.sent).toBe(1);
      expect(
        posts[0]?.map((message) => message.user?.workspaceSlug ?? message.pulses[0]?.slug),
      ).toEqual(["acme"]);
      expect(posts[0]?.[0]?.unsubscribes).toEqual(["workspace"]);
      expect(posts[0]?.[0]?.user).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });
});

const API_ROOT = fileURLToPath(new NodeURL("../", import.meta.url));

describe("member weekly digest migration", () => {
  it("copies an account-wide opt-in onto current memberships", () => {
    const prior = MIGRATIONS.filter((path) => !path.endsWith("auth_member_weekly_digest.sql"));
    const sqlite = new SqliteD1(prior);
    try {
      sqlite.db.exec(`
        INSERT INTO organization (id, name, slug, created_at) VALUES
          ('org-acme', 'Acme', 'acme', 1),
          ('org-beta', 'Beta', 'beta', 1);
        INSERT INTO user (id, name, email, created_at, updated_at, notify_weekly_digest, notify_weekly_workspace_digest) VALUES
          ('ada', 'Ada', 'ada@example.com', 1, 1, 1, 1),
          ('bev', 'Bev', 'bev@example.com', 1, 1, 0, 1),
          ('cy', 'Cy', 'cy@example.com', 1, 1, 0, 0);
        INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES
          ('m1', 'org-acme', 'ada', 'owner', 1),
          ('m2', 'org-beta', 'ada', 'member', 1),
          ('m3', 'org-acme', 'bev', 'admin', 1),
          ('m4', 'org-beta', 'bev', 'member', 1),
          ('m5', 'org-acme', 'cy', 'owner', 1);
      `);
      sqlite.db.exec(
        readFileSync(
          resolve(API_ROOT, "migrations/20261012150000_auth_member_weekly_digest.sql"),
          "utf8",
        ),
      );
      const rows = sqlite.db
        .prepare(
          `SELECT id, notify_weekly_digest AS digest, notify_weekly_workspace_digest AS pulse
           FROM member ORDER BY id`,
        )
        .all();
      expect(rows).toEqual([
        { id: "m1", digest: 1, pulse: 1 },
        { id: "m2", digest: 1, pulse: 0 },
        { id: "m3", digest: 0, pulse: 1 },
        { id: "m4", digest: 0, pulse: 0 },
        { id: "m5", digest: 0, pulse: 0 },
      ]);
    } finally {
      sqlite.close();
    }
  });
});
