import { afterEach, describe, expect, it, vi } from "vitest";
import { database, SqliteD1 } from "../../api/test/helpers/sqlite-d1";
import { botTokenFor, type SlackEnv } from "../src/config";
import { open, seal } from "../src/crypto";
import { createApp } from "../src/index";
import { installedBotToken, revokeInstall, saveInstall } from "../src/installs";
import { verifyState } from "../src/oauth";
import { signSlackRequest } from "../src/slack/signature";

const MIGRATION = "migrations/20261018160000_slack_installations.sql";
const KEY = "test-tokens-key-0123456789";
const SECRET = "test-signing-secret";

let sqlite: SqliteD1 | null = null;
afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

function env(overrides: Partial<SlackEnv> = {}): SlackEnv {
  sqlite ??= new SqliteD1(MIGRATION);
  return {
    SLACK_ORIGIN: "https://agents.uploads.sh",
    SLACK_APP_ID: "A123",
    SLACK_CLIENT_ID: "111.222",
    SLACK_CLIENT_SECRET: "client-secret",
    SLACK_TOKENS_KEY: KEY,
    SLACK_SIGNING_SECRET: SECRET,
    DB: database(sqlite),
    ...overrides,
  };
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

/** Starts an install and returns the state param and the cookie the browser would carry. */
async function startInstall(e: SlackEnv) {
  const res = await createApp().fetch(
    new Request("https://agents.uploads.sh/slack/install"),
    e,
    ctx().ctx,
  );
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("Location")!);
  const cookie = res.headers.get("Set-Cookie")!.split(";")[0]!;
  return { location, state: location.searchParams.get("state")!, cookie };
}

function oauthAccess(body: Record<string, unknown>) {
  const calls: URLSearchParams[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("https://slack.com/api/oauth.v2.access");
    calls.push(new URLSearchParams(String(init?.body)));
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const GRANT = {
  ok: true,
  access_token: "xoxb-new-team-token",
  token_type: "bot",
  scope: "links:read,links:write",
  bot_user_id: "UBOT",
  app_id: "A123",
  team: { id: "T777", name: "Acme" },
  enterprise: null,
  is_enterprise_install: false,
  authed_user: { id: "UINSTALLER" },
};

async function callback(
  e: SlackEnv,
  query: string,
  cookie: string | null,
  slackFetch?: typeof fetch,
) {
  return createApp({ slackFetch }).fetch(
    new Request(`https://agents.uploads.sh/slack/oauth/callback?${query}`, {
      headers: cookie ? { Cookie: cookie } : {},
    }),
    e,
    ctx().ctx,
  );
}

describe("crypto", () => {
  it("round-trips sealed values and rejects the wrong key", async () => {
    const sealed = await seal(KEY, "xoxb-secret");
    expect(sealed.startsWith("enc:v1:")).toBe(true);
    expect(sealed).not.toContain("xoxb");
    expect(await open(KEY, sealed)).toBe("xoxb-secret");
    await expect(open("another-key-0123456789", sealed)).rejects.toThrow();
  });

  it("refuses to seal without a long enough key", async () => {
    await expect(seal(undefined, "x")).rejects.toThrow(/SLACK_TOKENS_KEY/);
    await expect(seal("short", "x")).rejects.toThrow(/SLACK_TOKENS_KEY/);
  });
});

describe("GET /slack/install", () => {
  it("redirects to Slack with scopes, redirect URI, and a signed state bound to a cookie", async () => {
    const e = env();
    const { location, state, cookie } = await startInstall(e);
    expect(location.origin + location.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(location.searchParams.get("client_id")).toBe("111.222");
    expect(location.searchParams.get("scope")).toBe("links:read,links:write");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://agents.uploads.sh/slack/oauth/callback",
    );
    const nonce = await verifyState(e, state);
    expect(nonce).toBeTruthy();
    expect(cookie).toBe(`__Host-uploads_slack_oauth=${nonce}`);
  });

  it("answers 503 when OAuth isn't configured", async () => {
    const res = await createApp().fetch(
      new Request("https://agents.uploads.sh/slack/install"),
      env({ SLACK_CLIENT_SECRET: undefined }),
      ctx().ctx,
    );
    expect(res.status).toBe(503);
  });
});

describe("verifyState", () => {
  it("rejects tampered, expired, and malformed states", async () => {
    const e = env();
    const { state } = await startInstall(e);
    const [nonce, expires, mac] = state.split(".");
    expect(await verifyState(e, `${nonce}x.${expires}.${mac}`)).toBeNull();
    expect(await verifyState(e, state, Number(expires) + 1)).toBeNull();
    expect(await verifyState(e, "garbage")).toBeNull();
    expect(
      await verifyState({ ...e, SLACK_TOKENS_KEY: "different-key-0123456789" }, state),
    ).toBeNull();
  });
});

describe("GET /slack/oauth/callback", () => {
  it("exchanges the code and stores a sealed per-team token", async () => {
    const e = env();
    const { state, cookie } = await startInstall(e);
    const slack = oauthAccess(GRANT);
    const res = await callback(
      e,
      `code=abc&state=${encodeURIComponent(state)}`,
      cookie,
      slack.fetch,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("uploads.sh is installed in Acme");
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(slack.calls[0]!.get("code")).toBe("abc");
    expect(slack.calls[0]!.get("client_secret")).toBe("client-secret");
    expect(slack.calls[0]!.get("redirect_uri")).toBe(
      "https://agents.uploads.sh/slack/oauth/callback",
    );

    const row = sqlite!.db
      .prepare("SELECT * FROM slack_installations WHERE team_id = 'T777'")
      .get() as Record<string, string>;
    expect(row.bot_token).toMatch(/^enc:v1:/);
    expect(row.bot_token).not.toContain("xoxb");
    expect(row).toMatchObject({
      team_name: "Acme",
      bot_user_id: "UBOT",
      installed_by_slack_user_id: "UINSTALLER",
    });
    expect(await botTokenFor(e, "T777")).toBe("xoxb-new-team-token");
  });

  it("rejects a callback without the matching cookie (CSRF)", async () => {
    const e = env();
    const { state } = await startInstall(e);
    const slack = oauthAccess(GRANT);
    const res = await callback(
      e,
      `code=abc&state=${encodeURIComponent(state)}`,
      "__Host-uploads_slack_oauth=other",
      slack.fetch,
    );
    expect(res.status).toBe(400);
    expect(slack.fetch).not.toHaveBeenCalled();
    const missing = await callback(
      e,
      `code=abc&state=${encodeURIComponent(state)}`,
      null,
      slack.fetch,
    );
    expect(missing.status).toBe(400);
  });

  it("refuses org-wide installs and failed grants without storing anything", async () => {
    const e = env();
    for (const grant of [
      { ...GRANT, is_enterprise_install: true, team: null },
      { ok: false, error: "invalid_code" },
    ]) {
      const { state, cookie } = await startInstall(e);
      const res = await callback(
        e,
        `code=abc&state=${encodeURIComponent(state)}`,
        cookie,
        oauthAccess(grant).fetch,
      );
      expect(res.status).toBe(400);
    }
    expect(sqlite!.db.prepare("SELECT count(*) AS n FROM slack_installations").get()).toEqual({
      n: 0,
    });
  });

  it("shows a cancelled page when the user declines", async () => {
    const res = await callback(env(), "error=access_denied&state=x", null);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Install cancelled");
  });
});

describe("installs and token lookup", () => {
  const record = {
    teamId: "T1",
    teamName: "One",
    enterpriseId: null,
    appId: "A123",
    botUserId: "UB",
    botToken: "xoxb-one",
    scopes: "links:read",
    installedBySlackUserId: "U1",
  };

  it("revocation drops the token and a reinstall restores it", async () => {
    const e = env();
    await saveInstall(e.DB!, KEY, record);
    expect(await installedBotToken(e.DB!, KEY, "T1")).toBe("xoxb-one");
    await revokeInstall(e.DB!, "T1");
    expect(await installedBotToken(e.DB!, KEY, "T1")).toBeNull();
    await saveInstall(e.DB!, KEY, { ...record, botToken: "xoxb-two" });
    expect(await installedBotToken(e.DB!, KEY, "T1")).toBe("xoxb-two");
  });

  it("falls back to the legacy token only for its own team, and prefers an install", async () => {
    const e = env({ SLACK_BOT_TOKEN: "xoxb-legacy", SLACK_TEAM_ID: "T1" });
    expect(await botTokenFor(e, "T1")).toBe("xoxb-legacy");
    expect(await botTokenFor(e, "T2")).toBeNull();
    await saveInstall(e.DB!, KEY, record);
    expect(await botTokenFor(e, "T1")).toBe("xoxb-one");
  });

  it("app_uninstalled and tokens_revoked events revoke the install", async () => {
    const e = env();
    for (const event of [
      { type: "app_uninstalled" },
      { type: "tokens_revoked", tokens: { bot: ["UB"] } },
    ]) {
      await saveInstall(e.DB!, KEY, record);
      const body = JSON.stringify({ type: "event_callback", team_id: "T1", event });
      const ts = String(Math.floor(Date.now() / 1000));
      const { ctx: c, settle } = ctx();
      const res = await createApp().fetch(
        new Request("https://agents.uploads.sh/slack/events", {
          method: "POST",
          headers: {
            "X-Slack-Request-Timestamp": ts,
            "X-Slack-Signature": await signSlackRequest(SECRET, ts, body),
          },
          body,
        }),
        e,
        c,
      );
      expect(res.status).toBe(200);
      await settle();
      expect(await installedBotToken(e.DB!, KEY, "T1")).toBeNull();
    }
  });
});
