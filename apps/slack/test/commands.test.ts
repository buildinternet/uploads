import { afterEach, describe, expect, it, vi } from "vitest";
import { database, SqliteD1 } from "../../api/test/helpers/sqlite-d1";
import {
  resultsMessage,
  SHARE_ACTION,
  searchTerm,
  sharePageUrl,
  USAGE_TEXT,
} from "../src/commands";
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
    expect(JSON.stringify(slack.responses[0]!.blocks)).toContain(SHARE_ACTION);
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

  it("shows each result's folder, date and thumbnail, and one Share menu", () => {
    const msg = resultsMessage(
      "sunny",
      {
        bound: true,
        results: [
          {
            workspace: "acme",
            key: "screenshots/sunny/pr-1/plan.webp",
            imageUrl: "https://storage.uploads.sh/acme/plan.webp",
            uploaded: 1_792_281_600_000,
          },
          { workspace: "acme", key: "plan.svg", imageUrl: "https://x.test/plan.svg" },
          { workspace: "acme", key: `${"x".repeat(150)}/long.png` },
        ],
        truncated: false,
      },
      "https://uploads.sh",
    );
    const [heading, first, second, , divider, actions] = msg.blocks as Array<Record<string, any>>;
    expect(heading!.text.text).toBe("*3 newest files matching “sunny”*");
    expect(first!.text.text).toBe(
      "<https://uploads.sh/f/acme/screenshots/sunny/pr-1/plan.webp|*plan.webp*>\nsunny/pr-1 · <!date^1792281600^{date_short_pretty}|2026-10-18>",
    );
    expect(first!.accessory).toEqual({
      type: "image",
      image_url: "https://storage.uploads.sh/acme/plan.webp",
      alt_text: "plan.webp",
    });
    // Slack can't draw an SVG, so no thumbnail rather than a failed reply.
    expect(second!.accessory).toBeUndefined();
    expect(second!.text.text).toBe("<https://uploads.sh/f/acme/plan.svg|*plan.svg*>");
    expect(divider!.type).toBe("divider");
    const menu = actions!.elements[0];
    expect(menu).toMatchObject({ type: "static_select", action_id: SHARE_ACTION });
    // The path too long for an option value is left out of the menu.
    expect(menu.options.map((o: { value: string }) => o.value)).toEqual([
      "acme/screenshots/sunny/pr-1/plan.webp",
      "acme/plan.svg",
    ]);
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
    expect(msg.text).toContain("(from the first matches)");
    expect(JSON.stringify(msg.blocks)).toContain("b · two");
    expect(JSON.stringify(msg.blocks)).not.toContain("· one");
  });

  it("encodes share page paths", () => {
    expect(sharePageUrl("https://uploads.sh/", "acme", "a b/c#d.png")).toBe(
      "https://uploads.sh/f/acme/a%20b/c%23d.png",
    );
  });
});

describe("Share a file", () => {
  /** uploads-api's public file endpoint, answering for `public` keys only. */
  function publicApi(publicKeys: string[]) {
    return {
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        const path = decodeURIComponent(new URL(String(input)).pathname);
        const key = path.replace(/^\/public\/files\/acme\//, "");
        if (!publicKeys.includes(key)) return new Response("{}", { status: 404 });
        return Response.json({
          key,
          contentType: "image/webp",
          size: 1024,
          url: `https://storage.uploads.sh/acme/${key}`,
          uploaded: "2026-10-14T00:00:00Z",
        });
      }),
    } as unknown as Fetcher;
  }

  async function pick(value: string, api: Fetcher) {
    const env = await setup({ API: api });
    const slack = fakeSlack(MEMBER);
    const body = new URLSearchParams({
      payload: JSON.stringify({
        type: "block_actions",
        team: { id: "T1" },
        user: { id: "U0ALICE" },
        response_url: RESPONSE_URL,
        actions: [{ action_id: SHARE_ACTION, selected_option: { value } }],
      }),
    }).toString();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const { ctx: executionCtx, settle } = ctx();
    const res = await createApp({ slackFetch: slack.fetch }).fetch(
      new Request("https://agents.uploads.sh/slack/interactivity", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Slack-Request-Timestamp": timestamp,
          "X-Slack-Signature": await signSlackRequest(SECRET, timestamp, body),
        },
        body,
      }),
      env,
      executionCtx,
    );
    await settle();
    expect(res.status).toBe(200);
    return slack.responses;
  }

  it("posts the file's card to the channel", async () => {
    const responses = await pick("acme/sunny/plan.webp", publicApi(["sunny/plan.webp"]));
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      response_type: "in_channel",
      text: "<@U0ALICE> shared <https://uploads.sh/f/acme/sunny/plan.webp|plan.webp>",
    });
    const blocks = JSON.stringify(responses[0]!.blocks);
    expect(blocks).toContain("<@U0ALICE> shared");
    expect(blocks).toContain("https://storage.uploads.sh/acme/sunny/plan.webp");
  });

  it("tells only the presser when the file isn't public anymore", async () => {
    const responses = await pick("acme/sunny/plan.webp", publicApi([]));
    expect(responses).toEqual([
      expect.objectContaining({
        response_type: "ephemeral",
        text: "That file isn't public anymore, so it wasn't shared.",
      }),
    ]);
  });

  it("ignores a value it didn't write", async () => {
    const api = publicApi(["a.png"]);
    expect(await pick("Acme!/a.png", api)).toEqual([]);
    expect(await pick("no-slash", api)).toEqual([]);
  });
});
