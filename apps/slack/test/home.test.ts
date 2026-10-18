import { afterEach, describe, expect, it, vi } from "vitest";
import { database, SqliteD1 } from "../../api/test/helpers/sqlite-d1";
import type { SlackEnv } from "../src/config";
import { createApp } from "../src/index";
import { saveInstall } from "../src/installs";
import { ticketHash } from "../src/links";
import { signSlackRequest } from "../src/slack/signature";

const KEY = "test-tokens-key-0123456789";
const SECRET = "test-signing-secret";
const MIGRATIONS = [
  "migrations/20261018160000_slack_installations.sql",
  "migrations/20261018170000_slack_user_links.sql",
];

let sqlite: SqliteD1 | null = null;
afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

async function setup(scopes = "chat:write,im:write,links:read,links:write,users:read") {
  sqlite = new SqliteD1(MIGRATIONS);
  const env: SlackEnv = {
    WEB_ORIGIN: "https://uploads.sh",
    SLACK_TOKENS_KEY: KEY,
    SLACK_SIGNING_SECRET: SECRET,
    DB: database(sqlite),
  };
  await saveInstall(env.DB!, KEY, {
    teamId: "T1",
    teamName: "Acme",
    enterpriseId: null,
    appId: "A1",
    botUserId: "UBOT",
    botToken: "xoxb-acme",
    scopes,
    installedBySlackUserId: "U1",
  });
  return env;
}

function fakeSlack() {
  const views: Array<{ user_id: string; view: { blocks: Array<Record<string, any>> } }> = [];
  const lookups: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer xoxb-acme");
    if (String(input) === "https://slack.com/api/users.info") {
      lookups.push(new URLSearchParams(String(init?.body)).get("user")!);
      return new Response(
        JSON.stringify({ ok: true, user: { name: "alice", profile: { display_name: "Alice" } } }),
      );
    }
    expect(String(input)).toBe("https://slack.com/api/views.publish");
    views.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ ok: true }));
  }) as unknown as typeof globalThis.fetch;
  return { fetch, views, lookups };
}

async function signed(path: string, body: string, contentType: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  return new Request(`https://agents.uploads.sh${path}`, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      "X-Slack-Request-Timestamp": ts,
      "X-Slack-Signature": await signSlackRequest(SECRET, ts, body),
    },
    body,
  });
}

async function run(env: SlackEnv, request: Request, slackFetch: typeof globalThis.fetch) {
  const pending: Promise<unknown>[] = [];
  const res = await createApp({ slackFetch }).fetch(request, env, {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext);
  await Promise.all(pending);
  return res;
}

const homeOpened = (tab = "home") =>
  JSON.stringify({
    type: "event_callback",
    team_id: "T1",
    event: { type: "app_home_opened", user: "U42", tab },
  });

const buttonOf = (blocks: Array<Record<string, any>>) =>
  blocks.find((block) => block.accessory?.type === "button")!.accessory;

describe("Home tab", () => {
  it("shows an unlinked user a Connect button carrying a stored single-use ticket", async () => {
    const env = await setup();
    const slack = fakeSlack();
    const res = await run(
      env,
      await signed("/slack/events", homeOpened(), "application/json"),
      slack.fetch,
    );
    expect(res.status).toBe(200);
    expect(slack.views).toHaveLength(1);
    expect(slack.views[0]!.user_id).toBe("U42");

    const button = buttonOf(slack.views[0]!.view.blocks);
    const url = new URL(button.url);
    expect(url.origin + url.pathname).toBe("https://uploads.sh/slack/connect");
    const ticket = url.searchParams.get("ticket")!;
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{32}$/);

    const row = sqlite!.db.prepare("SELECT * FROM slack_link_tickets").get() as Record<
      string,
      string
    >;
    expect(row).toMatchObject({
      team_id: "T1",
      team_name: "Acme",
      slack_user_id: "U42",
      slack_user_name: "Alice",
    });
    expect(slack.lookups).toEqual(["U42"]);
    expect(row.ticket_hash).toBe(await ticketHash(ticket));
    expect(row.ticket_hash).not.toBe(ticket);
    expect(Date.parse(row.expires_at) - Date.parse(row.created_at)).toBe(30 * 60 * 1000);
  });

  it("shows a linked user their account and a Disconnect button", async () => {
    const env = await setup();
    sqlite!.db
      .prepare(
        "INSERT INTO slack_user_links (team_id, slack_user_id, user_id, user_email, linked_at) VALUES ('T1', 'U42', 'user_1', 'zach@example.com', '2026-10-18T00:00:00Z')",
      )
      .run();
    const slack = fakeSlack();
    await run(env, await signed("/slack/events", homeOpened(), "application/json"), slack.fetch);
    const blocks = slack.views[0]!.view.blocks;
    // Names no uploads.sh account, so a forwarded-link victim's email can't leak here.
    expect(JSON.stringify(blocks)).not.toContain("zach@example.com");
    expect(JSON.stringify(blocks)).toContain("<!date^1792281600^{date_short}|2026-10-18>");
    expect(buttonOf(blocks)).toMatchObject({ action_id: "uploads_disconnect" });
    expect(sqlite!.db.prepare("SELECT count(*) AS n FROM slack_link_tickets").get()).toEqual({
      n: 0,
    });
  });

  it("asks a workspace missing scopes to update, above everything else", async () => {
    const env = await setup("links:read,links:write,users:read");
    const slack = fakeSlack();
    await run(env, await signed("/slack/events", homeOpened(), "application/json"), slack.fetch);
    const blocks = slack.views[0]!.view.blocks;
    expect(blocks[0]!.text.text).toContain("held-upload messages");
    expect(blocks[0]!.accessory).toMatchObject({
      action_id: "uploads_update_permissions",
      url: "https://agents.uploads.sh/slack/install",
    });
    // The Connect button is still there below the banner.
    expect(blocks.some((b) => b.accessory?.action_id === "uploads_connect")).toBe(true);
  });

  it("shows no banner when every scope is granted", async () => {
    const env = await setup();
    const slack = fakeSlack();
    await run(env, await signed("/slack/events", homeOpened(), "application/json"), slack.fetch);
    expect(JSON.stringify(slack.views[0]!.view.blocks)).not.toContain("uploads_update_permissions");
  });

  it("ignores the Messages tab", async () => {
    const env = await setup();
    const slack = fakeSlack();
    await run(
      env,
      await signed("/slack/events", homeOpened("messages"), "application/json"),
      slack.fetch,
    );
    expect(slack.fetch).not.toHaveBeenCalled();
  });
});

const disconnectBody = (userId: string) =>
  new URLSearchParams({
    payload: JSON.stringify({
      type: "block_actions",
      team: { id: "T1" },
      user: { id: userId },
      actions: [{ action_id: "uploads_disconnect" }],
    }),
  }).toString();

describe("POST /slack/interactivity", () => {
  it("Disconnect removes only that user's link and re-renders Home", async () => {
    const env = await setup();
    for (const user of ["U42", "U99"]) {
      sqlite!.db
        .prepare(
          "INSERT INTO slack_user_links (team_id, slack_user_id, user_id, user_email, linked_at) VALUES ('T1', ?, ?, NULL, '2026-10-18T00:00:00Z')",
        )
        .run(user, `user_${user}`);
    }
    const slack = fakeSlack();
    const res = await run(
      env,
      await signed(
        "/slack/interactivity",
        disconnectBody("U42"),
        "application/x-www-form-urlencoded",
      ),
      slack.fetch,
    );
    expect(res.status).toBe(200);
    const left = sqlite!.db.prepare("SELECT slack_user_id FROM slack_user_links").all();
    expect(left).toEqual([{ slack_user_id: "U99" }]);
    expect(buttonOf(slack.views[0]!.view.blocks)).toMatchObject({ action_id: "uploads_connect" });
  });

  it("rejects unsigned requests", async () => {
    const env = await setup();
    const slack = fakeSlack();
    const res = await run(
      env,
      new Request("https://agents.uploads.sh/slack/interactivity", {
        method: "POST",
        body: disconnectBody("U42"),
      }),
      slack.fetch,
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /slack/internal/home", () => {
  const body = JSON.stringify({ teamId: "T1", slackUserId: "U42" });

  it("re-renders Home when called through the service binding host", async () => {
    const env = await setup();
    const slack = fakeSlack();
    const res = await run(
      env,
      new Request("https://slack.internal/slack/internal/home", { method: "POST", body }),
      slack.fetch,
    );
    expect(res.status).toBe(204);
    expect(slack.views[0]!.user_id).toBe("U42");
  });

  it("is not reachable on the public hostname", async () => {
    const env = await setup();
    const slack = fakeSlack();
    const res = await run(
      env,
      new Request("https://agents.uploads.sh/slack/internal/home", { method: "POST", body }),
      slack.fetch,
    );
    expect(res.status).toBe(404);
    expect(slack.fetch).not.toHaveBeenCalled();
  });
});
