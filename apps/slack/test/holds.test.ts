import { afterEach, describe, expect, it, vi } from "vitest";
import { database, SqliteD1 } from "../../api/test/helpers/sqlite-d1";
import type { SlackEnv } from "../src/config";
import {
  HOLD_APPROVE_ACTION,
  HOLD_KEEP_ACTION,
  holdButtonValue,
  holdMessage,
  parseHoldNotice,
} from "../src/holds";
import { createApp } from "../src/index";
import { saveInstall } from "../src/installs";
import { signSlackRequest } from "../src/slack/signature";

const KEY = "test-tokens-key-0123456789";
const SECRET = "test-signing-secret";
const RESPONSE_URL = "https://hooks.slack.com/actions/T1/123/abc";

let sqlite: SqliteD1 | null = null;
afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

async function setup(overrides: Partial<SlackEnv> = {}) {
  sqlite = new SqliteD1([
    "migrations/20261018160000_slack_installations.sql",
    "migrations/20261021130000_slack_hold_messages.sql",
  ]);
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
    scopes: "links:read,links:write,chat:write,im:write",
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

/** Records Slack calls; answers conversations.open with a DM channel. */
function fakeSlack() {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    if (url.endsWith("/conversations.open")) {
      return Response.json({ ok: true, channel: { id: "D123" } });
    }
    if (url.endsWith("/chat.postMessage")) {
      return Response.json({ ok: true, channel: "D123", ts: "1700000000.000100" });
    }
    return Response.json({ ok: true });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const NOTICE = {
  teamId: "T1",
  slackUserId: "U0ALICE",
  workspace: "acme",
  key: "gh/acme/app/pull/12/env.png",
  reason: "secret",
  pageUrl: "https://uploads.sh/f/acme/gh/acme/app/pull/12/env.png",
  isUploader: true,
};

function internal(path: string, body: unknown, host = "slack.internal") {
  return new Request(`https://${host}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function buttonPress(actionId: string, value: string) {
  const payload = {
    type: "block_actions",
    team: { id: "T1" },
    user: { id: "U0ALICE", team_id: "T1" },
    actions: [{ action_id: actionId, value }],
    response_url: RESPONSE_URL,
  };
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const ts = String(Math.floor(Date.now() / 1000));
  return new Request("https://agents.uploads.sh/slack/interactivity", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Slack-Request-Timestamp": ts,
      "X-Slack-Signature": await signSlackRequest(SECRET, ts, body),
    },
    body,
  });
}

describe("hold notices", () => {
  it("validates the internal body and drops foreign page links", () => {
    expect(parseHoldNotice(NOTICE, "https://uploads.sh")).toMatchObject({ key: NOTICE.key });
    expect(parseHoldNotice({ ...NOTICE, teamId: "nope" }, "https://uploads.sh")).toBeNull();
    expect(parseHoldNotice({ ...NOTICE, reason: "other" }, "https://uploads.sh")).toBeNull();
    expect(
      parseHoldNotice({ ...NOTICE, pageUrl: "https://evil.example/x" }, "https://uploads.sh")
        ?.pageUrl,
    ).toBe("");
  });

  it("words the DM for the uploader and for an admin", () => {
    const own = holdMessage(parseHoldNotice(NOTICE, "https://uploads.sh")!);
    expect(own.text).toBe("Your upload is held for review: env.png");
    const admin = holdMessage(
      parseHoldNotice({ ...NOTICE, isUploader: false, reason: "pii" }, "https://uploads.sh")!,
    );
    expect(admin.text).toBe("An upload in acme is held for review: env.png");
    expect(JSON.stringify(admin.blocks)).toContain("personal information");
    const actions = admin.blocks.find((b) => b.type === "actions") as {
      elements: { action_id: string; value: string }[];
    };
    expect(actions.elements.map((e) => e.action_id)).toEqual([
      HOLD_APPROVE_ACTION,
      HOLD_KEEP_ACTION,
    ]);
    expect(JSON.parse(actions.elements[0]!.value)).toEqual({ w: "acme", k: NOTICE.key });
  });

  it("names the flagged kind and links the settings", () => {
    const named = JSON.stringify(
      holdMessage(parseHoldNotice({ ...NOTICE, kind: "api_key" }, "https://uploads.sh/")!).blocks,
    );
    expect(named).toContain("Held because it may show an API key.");
    expect(named).toContain(
      "<https://uploads.sh/account/workspaces/acme/settings/ai-labels|Settings → AI labels>",
    );
    expect(named).toContain("<https://uploads.sh/account/profile|your profile>");
    // A value without wording, or one from the other field, reads as the generic reason.
    const unknown = parseHoldNotice({ ...NOTICE, kind: "financial" }, "https://uploads.sh")!;
    expect(unknown.kind).toBeUndefined();
    expect(JSON.stringify(holdMessage(unknown).blocks)).toContain("such as an API key, password");
  });

  it("DMs the user over the internal route", async () => {
    const env = await setup();
    const slack = fakeSlack();
    const res = await createApp({ slackFetch: slack.fetch }).fetch(
      internal("/slack/internal/hold", NOTICE),
      env,
      ctx().ctx,
    );
    expect(res.status).toBe(204);
    expect(slack.calls.map((c) => c.url.split("/").pop())).toEqual([
      "conversations.open",
      "chat.postMessage",
    ]);
    expect(slack.calls[0]!.body).toEqual({ users: "U0ALICE" });
    expect(slack.calls[1]!.body).toMatchObject({ channel: "D123" });
  });

  it("is unreachable from the public route", async () => {
    const env = await setup();
    const slack = fakeSlack();
    const res = await createApp({ slackFetch: slack.fetch }).fetch(
      internal("/slack/internal/hold", NOTICE, "agents.uploads.sh"),
      env,
      ctx().ctx,
    );
    expect(res.status).toBe(404);
    expect(slack.fetch).not.toHaveBeenCalled();
  });

  it("reports a team that never installed the app", async () => {
    const env = await setup();
    const slack = fakeSlack();
    const res = await createApp({ slackFetch: slack.fetch }).fetch(
      internal("/slack/internal/hold", { ...NOTICE, teamId: "T9" }),
      env,
      ctx().ctx,
    );
    expect(res.status).toBe(502);
    expect(slack.fetch).not.toHaveBeenCalled();
  });
});

describe("resolved holds", () => {
  async function sendDm(env: SlackEnv) {
    const slack = fakeSlack();
    await createApp({ slackFetch: slack.fetch }).fetch(
      internal("/slack/internal/hold", NOTICE),
      env,
      ctx().ctx,
    );
  }
  const saved = (env: SlackEnv) =>
    env.DB!.prepare("SELECT channel, ts, workspace, object_key FROM slack_hold_messages").all();

  it("saves the DM so it can be rewritten later", async () => {
    const env = await setup();
    await sendDm(env);
    expect((await saved(env)).results).toEqual([
      { channel: "D123", ts: "1700000000.000100", workspace: "acme", object_key: NOTICE.key },
    ]);
  });

  it("rewrites the DM when the hold is approved elsewhere, then forgets it", async () => {
    const env = await setup();
    await sendDm(env);
    const slack = fakeSlack();
    const res = await createApp({ slackFetch: slack.fetch }).fetch(
      internal("/slack/internal/hold-resolved", {
        workspace: "acme",
        key: NOTICE.key,
        outcome: "approved",
        by: "Zach",
      }),
      env,
      ctx().ctx,
    );
    expect(res.status).toBe(204);
    expect(slack.calls).toHaveLength(1);
    expect(slack.calls[0]!.url).toMatch(/\/chat\.update$/);
    expect(slack.calls[0]!.body).toMatchObject({ channel: "D123", ts: "1700000000.000100" });
    const body = JSON.stringify(slack.calls[0]!.body);
    expect(body).toContain("Approved by Zach");
    expect(body).toContain(NOTICE.pageUrl);
    expect(body).not.toContain(HOLD_APPROVE_ACTION);
    expect((await saved(env)).results).toEqual([]);
  });

  it("says the file was deleted, without a link", async () => {
    const env = await setup();
    await sendDm(env);
    const slack = fakeSlack();
    await createApp({ slackFetch: slack.fetch }).fetch(
      internal("/slack/internal/hold-resolved", {
        workspace: "acme",
        key: NOTICE.key,
        outcome: "deleted",
      }),
      env,
      ctx().ctx,
    );
    const body = JSON.stringify(slack.calls[0]!.body);
    expect(body).toContain("Deleted while it was held");
    expect(body).not.toContain("https://uploads.sh/f/");
  });

  it("does nothing for a file with no saved DM, and is internal only", async () => {
    const env = await setup();
    const slack = fakeSlack();
    const app = createApp({ slackFetch: slack.fetch });
    const body = { workspace: "acme", key: NOTICE.key, outcome: "deleted" };
    expect(
      (await app.fetch(internal("/slack/internal/hold-resolved", body), env, ctx().ctx)).status,
    ).toBe(204);
    expect(
      (
        await app.fetch(
          internal("/slack/internal/hold-resolved", body, "agents.uploads.sh"),
          env,
          ctx().ctx,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await app.fetch(
          internal("/slack/internal/hold-resolved", { ...body, outcome: "kept" }),
          env,
          ctx().ctx,
        )
      ).status,
    ).toBe(400);
    expect(slack.fetch).not.toHaveBeenCalled();
  });
});

describe("hold buttons", () => {
  function apiReturning(status: number, body: unknown) {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetcher = {
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return Response.json(body, { status });
      }),
    } as unknown as Fetcher;
    return { fetcher, calls };
  }

  it("Approve calls the internal API as the presser and rewrites the DM", async () => {
    const api = apiReturning(200, { key: NOTICE.key, approved: true });
    const env = await setup({ API: api.fetcher });
    const slack = fakeSlack();
    const { ctx: c, settle } = ctx();
    const res = await createApp({ slackFetch: slack.fetch }).fetch(
      await buttonPress(HOLD_APPROVE_ACTION, holdButtonValue("acme", NOTICE.key)),
      env,
      c,
    );
    expect(res.status).toBe(200);
    await settle();
    expect(api.calls).toEqual([
      {
        url: "https://api.internal/internal/slack/approve",
        body: { teamId: "T1", slackUserId: "U0ALICE", workspace: "acme", key: NOTICE.key },
      },
    ]);
    expect(slack.calls).toHaveLength(1);
    expect(slack.calls[0]!.url).toBe(RESPONSE_URL);
    expect(slack.calls[0]!.body).toMatchObject({ replace_original: true });
    expect(JSON.stringify(slack.calls[0]!.body)).toContain("Approved by you");
  });

  it("a refused approve answers only the presser and keeps the buttons", async () => {
    const api = apiReturning(404, { error: "not_found" });
    const env = await setup({ API: api.fetcher });
    const slack = fakeSlack();
    const { ctx: c, settle } = ctx();
    await createApp({ slackFetch: slack.fetch }).fetch(
      await buttonPress(HOLD_APPROVE_ACTION, holdButtonValue("acme", NOTICE.key)),
      env,
      c,
    );
    await settle();
    expect(slack.calls[0]!.body).toMatchObject({
      replace_original: false,
      response_type: "ephemeral",
    });
    expect(JSON.stringify(slack.calls[0]!.body)).toContain("Home tab");
  });

  it("Keep held never calls the API", async () => {
    const api = apiReturning(200, {});
    const env = await setup({ API: api.fetcher });
    const slack = fakeSlack();
    const { ctx: c, settle } = ctx();
    await createApp({ slackFetch: slack.fetch }).fetch(
      await buttonPress(HOLD_KEEP_ACTION, holdButtonValue("acme", NOTICE.key)),
      env,
      c,
    );
    await settle();
    expect(api.calls).toHaveLength(0);
    expect(JSON.stringify(slack.calls[0]!.body)).toContain("Kept held");
  });
});
