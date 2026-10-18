import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { database, SqliteD1 } from "../test/helpers/sqlite-d1";
import { notifySlackOfHold, slackHoldRecipients } from "./slack-hold-notify";

const MIGRATIONS = [
  "migrations/20260822120000_auth_tables.sql",
  "migrations/20261018170000_slack_user_links.sql",
  "migrations/20261018180000_user_notify_slack_holds.sql",
];

let sqlite: SqliteD1;

beforeEach(() => {
  sqlite = new SqliteD1(MIGRATIONS);
  const db = sqlite.db;
  db.prepare(
    "INSERT INTO organization (id, name, slug, created_at) VALUES ('o1', 'Acme', 'acme', 0)",
  ).run();
  for (const [id, role] of [
    ["u-owner", "owner"],
    ["u-admin", "admin"],
    ["u-member", "member"],
  ] as const) {
    db.prepare(
      "INSERT INTO user (id, name, email, created_at, updated_at) VALUES (?, ?, ?, 0, 0)",
    ).run(id, id, `${id}@example.com`);
    db.prepare(
      "INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, 'o1', ?, ?, 0)",
    ).run(`m-${id}`, id, role);
  }
  // An outsider with a Slack link, to prove membership is required.
  db.prepare(
    "INSERT INTO user (id, name, email, created_at, updated_at) VALUES ('u-out', 'out', 'out@example.com', 0, 0)",
  ).run();
});

afterEach(() => {
  sqlite.close();
});

function link(userId: string, slackUserId: string, teamId = "T0TEAM1") {
  sqlite.db
    .prepare(
      "INSERT INTO slack_user_links (team_id, slack_user_id, user_id, linked_at) VALUES (?, ?, ?, '2026-10-18')",
    )
    .run(teamId, slackUserId, userId);
}

describe("slackHoldRecipients", () => {
  it("messages only the uploader when they are a member", async () => {
    link("u-member", "U0MEMBER");
    link("u-owner", "U0OWNER");
    const got = await slackHoldRecipients(database(sqlite), "acme", "u-member");
    expect(got).toEqual([{ teamId: "T0TEAM1", slackUserId: "U0MEMBER", userId: "u-member" }]);
  });

  it("does not fall back to admins when a member uploader has no Slack link", async () => {
    link("u-owner", "U0OWNER");
    expect(await slackHoldRecipients(database(sqlite), "acme", "u-member")).toEqual([]);
  });

  it("falls back to admins and owners without an uploader", async () => {
    link("u-owner", "U0OWNER");
    link("u-admin", "U0ADMIN");
    link("u-member", "U0MEMBER");
    const got = await slackHoldRecipients(database(sqlite), "acme", undefined);
    expect(got.map((r) => r.userId).sort()).toEqual(["u-admin", "u-owner"]);
  });

  it("falls back to admins when the uploader left the workspace", async () => {
    link("u-out", "U0OUT");
    link("u-admin", "U0ADMIN");
    const got = await slackHoldRecipients(database(sqlite), "acme", "u-out");
    expect(got.map((r) => r.userId)).toEqual(["u-admin"]);
  });

  it("respects the preference and bans, and covers every linked Slack workspace", async () => {
    link("u-owner", "U0OWNER", "T0TEAM1");
    link("u-owner", "U0OWNER2", "T0TEAM2");
    link("u-admin", "U0ADMIN");
    sqlite.db.prepare("UPDATE user SET notify_slack_holds = 0 WHERE id = 'u-admin'").run();
    let got = await slackHoldRecipients(database(sqlite), "acme", undefined);
    expect(got.map((r) => r.teamId).sort()).toEqual(["T0TEAM1", "T0TEAM2"]);
    sqlite.db.prepare("UPDATE user SET banned = 1 WHERE id = 'u-owner'").run();
    got = await slackHoldRecipients(database(sqlite), "acme", undefined);
    expect(got).toEqual([]);
  });
});

describe("notifySlackOfHold", () => {
  it("posts one internal message per recipient", async () => {
    link("u-member", "U0MEMBER");
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const env = {
      DB: database(sqlite),
      WEB_ORIGIN: "https://uploads.sh",
      SLACK: {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
          return new Response(null, { status: 204 });
        },
      },
    } as unknown as Env;
    const sent = await notifySlackOfHold(env, "acme", "shots/a b.png", "secret", {
      "gh.uploader-id": "u-member",
    });
    expect(sent).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://slack.internal/slack/internal/hold");
    expect(calls[0]!.body).toMatchObject({
      teamId: "T0TEAM1",
      slackUserId: "U0MEMBER",
      workspace: "acme",
      key: "shots/a b.png",
      reason: "secret",
      isUploader: true,
      pageUrl: "https://uploads.sh/f/acme/shots/a%20b.png",
    });
  });

  it("is a no-op without the binding and never throws", async () => {
    expect(await notifySlackOfHold({} as Env, "acme", "k.png", "pii", {})).toBe(0);
    const broken = { SLACK: { fetch: async () => new Response() } } as unknown as Env;
    expect(await notifySlackOfHold(broken, "acme", "k.png", "pii", {})).toBe(0);
  });
});
