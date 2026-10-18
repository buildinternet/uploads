import { afterEach, describe, expect, it, vi } from "vitest";
import { database, SqliteD1 } from "../../api/test/helpers/sqlite-d1";
import { resultsMessage, searchTerm, sharePageUrl, USAGE_TEXT } from "../src/commands";
import type { SlackEnv } from "../src/config";
import { createApp } from "../src/index";
import { saveInstall } from "../src/installs";
import { signSlackRequest } from "../src/slack/signature";

const KEY = "test-tokens-key-0123456789";
const SECRET = "test-signing-secret";
const RESPONSE_URL = "https://hooks.slack.com/commands/T1/123/abc";

let sqlite: SqliteD1 | null = null;
afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

async function setup(overrides: Partial<SlackEnv> = {}) {
  sqlite = new SqliteD1("migrations/20261018160000_slack_installations.sql");
  const env: SlackEnv = {
    WEB_ORIGIN: "https://uploads.sh",
    SLACK_TOKENS_KEY: KEY,
    SLACK_SIGNING_SECRET: SECRET,
    DB: database(sqlite),
    ...overrides,
  };
  await saveInstall(env.DB!, KEY, {
    teamId: "T1",
    teamName: "Acme",
    enterpriseId: null,
    appId: "A1",
    botUserId: "UBOT",
    botToken: "xoxb-acme",
    scopes: "commands,users:read",
    installedBySlackUserId: "U1",
  });
  return env;
}

function ctx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (p: Promise<unknown>) => pending.push(p),
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext,
    settle: () => Promise.all(pending),
  };
}

/** Answers users.info with `user`, records response_url posts. */
function fakeSlack(user: Record<string, unknown>) {
  const responses: Record<string, unknown>[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/users.info")) return Response.json({ ok: true, user });
    if (url.startsWith("https://hooks.slack.com/")) {
      responses.push(JSON.parse(String(init?.body ?? "{}")));
    }
    return Response.json({ ok: true });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, responses };
}

function fakeApi(body: unknown) {
  const calls: Record<string, unknown>[] = [];
  const fetcher = {
    fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.internal/internal/slack/search");
      calls.push(JSON.parse(String(init?.body ?? "{}")));
      return Response.json(body);
    }),
  } as unknown as Fetcher;
  return { fetcher, calls };
}

async function command(env: SlackEnv, slackFetch: typeof globalThis.fetch, text: string) {
  const body = new URLSearchParams({
    command: "/uploads",
    text,
    team_id: "T1",
    user_id: "U0ALICE",
    response_url: RESPONSE_URL,
  }).toString();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await signSlackRequest(SECRET, timestamp, body);
  const { ctx: executionCtx, settle } = ctx();
  const res = await createApp({ slackFetch }).fetch(
    new Request("https://agents.uploads.sh/slack/commands", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Slack-Request-Timestamp": timestamp,
        "X-Slack-Signature": signature,
      },
      body,
    }),
    env,
    executionCtx,
  );
  await settle();
  return res;
}

const MEMBER = { id: "U0ALICE", team_id: "T1", is_restricted: false, is_ultra_restricted: false };

describe("/uploads search", () => {
  it("parses the term", () => {
    expect(searchTerm("search login page")).toBe("login page");
    expect(searchTerm("  SEARCH  shot.png ")).toBe("shot.png");
    expect(searchTerm("search")).toBeNull();
    expect(searchTerm("help")).toBeNull();
  });

  it("answers anything that isn't a search with usage", async () => {
    const env = await setup();
    const slack = fakeSlack(MEMBER);
    const res = await command(env, slack.fetch, "");
    expect(await res.json()).toEqual({ response_type: "ephemeral", text: USAGE_TEXT });
  });

  it("rejects an unsigned request", async () => {
    const env = await setup();
    const res = await createApp().fetch(
      new Request("https://agents.uploads.sh/slack/commands", {
        method: "POST",
        body: "text=search+x",
      }),
      env,
      ctx().ctx,
    );
    expect(res.status).toBe(401);
  });

  it("searches for a full member and posts links to the share pages", async () => {
    const api = fakeApi({
      bound: true,
      results: [{ workspace: "acme", key: "screenshots/login page.png" }],
      truncated: false,
    });
    const env = await setup({ API: api.fetcher });
    const slack = fakeSlack(MEMBER);
    const res = await command(env, slack.fetch, "search login");
    expect(await res.json()).toEqual({
      response_type: "ephemeral",
      text: "Searching for “login”…",
    });
    expect(api.calls).toEqual([{ teamId: "T1", term: "login" }]);
    expect(slack.responses).toHaveLength(1);
    expect(slack.responses[0]).toMatchObject({ response_type: "ephemeral" });
    expect(String(slack.responses[0]!.text)).toContain(
      "<https://uploads.sh/f/acme/screenshots/login%20page.png|login page.png>",
    );
  });

  it("refuses guests without calling the API", async () => {
    const api = fakeApi({ bound: true, results: [], truncated: false });
    const env = await setup({ API: api.fetcher });
    const slack = fakeSlack({ ...MEMBER, is_restricted: true });
    await command(env, slack.fetch, "search login");
    expect(api.calls).toHaveLength(0);
    expect(String(slack.responses[0]!.text)).toContain("only available to full members");
  });

  it("refuses people from another Slack org", async () => {
    const api = fakeApi({ bound: true, results: [], truncated: false });
    const env = await setup({ API: api.fetcher });
    const slack = fakeSlack({ ...MEMBER, team_id: "T2" });
    await command(env, slack.fetch, "search login");
    expect(api.calls).toHaveLength(0);
  });
});

describe("resultsMessage", () => {
  it("explains when no uploads.sh workspace is bound", () => {
    const msg = resultsMessage(
      "x",
      { bound: false, results: [], truncated: false },
      "https://uploads.sh",
    );
    expect(msg.text).toContain("Settings → Slack");
  });

  it("says so when nothing matches", () => {
    const msg = resultsMessage(
      "x",
      { bound: true, results: [], truncated: false },
      "https://uploads.sh",
    );
    expect(msg.text).toBe("No public files match “x”.");
  });

  it("names the workspace only when results span several", () => {
    const msg = resultsMessage(
      "a",
      {
        bound: true,
        results: [
          { workspace: "one", key: "a.png" },
          { workspace: "two", key: "b/a.png" },
        ],
        truncated: true,
      },
      "https://uploads.sh",
    );
    expect(msg.text).toContain("(first matches only)");
    expect(msg.text).toContain("·  two");
  });

  it("encodes share page paths", () => {
    expect(sharePageUrl("https://uploads.sh/", "acme", "a b/c#d.png")).toBe(
      "https://uploads.sh/f/acme/a%20b/c%23d.png",
    );
  });
});
