import { afterEach, describe, expect, it, vi } from "vitest";
import { database, SqliteD1 } from "../../api/test/helpers/sqlite-d1";
import {
  answerQuestion,
  DEFAULT_AGENT_MODEL,
  lookUrl,
  OPENROUTER_CHAT_URL,
  type Complete,
  type CompletionRequest,
  type ToolCall,
} from "../src/agent";
import type { SearchResponse } from "../src/commands";
import type { SlackEnv } from "../src/config";
import { createApp } from "../src/index";
import { saveInstall } from "../src/installs";
import { SLACK_AGENT_DEFAULT_MODEL } from "../../api/src/platform-settings";
import { questionText } from "../src/mentions";
import { signSlackRequest } from "../src/slack/signature";

const KEY = "test-tokens-key-0123456789";
const SECRET = "test-signing-secret";

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

/** A model that plays back `turns` in order and records each request. */
function scripted(turns: ({ content: string | null; tool_calls?: ToolCall[] } | null)[]) {
  const requests: CompletionRequest[] = [];
  const complete: Complete = async (request) => {
    requests.push(structuredClone(request));
    return turns.shift() ?? null;
  };
  return { complete, requests };
}

const SETTINGS: SearchResponse = {
  bound: true,
  truncated: false,
  results: [
    {
      workspace: "acme",
      key: "shots/settings-slack.png",
      imageUrl: "https://storage.uploads.sh/acme/shots/settings-slack.png",
      uploaded: Date.parse("2026-10-19"),
      labels: { kind: "screenshot", screen: "settings", surface: "desktop" },
    },
    {
      workspace: "acme",
      key: "shots/account.png",
      imageUrl: "https://storage.uploads.sh/acme/shots/account.png",
      uploaded: Date.parse("2026-10-18"),
      labels: { kind: "screenshot", screen: "settings", surface: "mobile" },
    },
  ],
};

describe("answerQuestion", () => {
  it("searches by labels, looks at the images, and replies with the files it picked", async () => {
    const model = scripted([
      {
        content: null,
        tool_calls: [call("c1", "search_files", { kind: "screenshot", screen: "settings" })],
      },
      { content: null, tool_calls: [call("c2", "look_at_files", { ids: ["f1", "f2", "f9"] })] },
      {
        content: null,
        tool_calls: [call("c3", "reply", { text: "Two from this week.", file_ids: ["f2", "f7"] })],
      },
    ]);
    const search = vi.fn(async () => SETTINGS);
    const answer = await answerQuestion(
      { question: "any recent screenshots from settings?", context: [] },
      { complete: model.complete, search },
    );
    expect(search).toHaveBeenCalledWith("", { kind: "screenshot", screen: "settings" });
    expect(answer).toEqual({
      text: "Two from this week.",
      files: [SETTINGS.results[1]],
      answered: true,
    });
    // The search result the model read names ids, dates and labels.
    const toolResult = model.requests[1]!.messages.at(-1)!;
    expect(toolResult).toMatchObject({ role: "tool", tool_call_id: "c1" });
    expect(String(toolResult.content)).toContain(
      "f2: shots/account.png · 2026-10-18 · kind=screenshot screen=settings surface=mobile",
    );
    // Images go in a user message after the tool result, resized on our hosts.
    const images = model.requests[2]!.messages.at(-1)!;
    expect(images.role).toBe("user");
    expect(images.content).toContainEqual({
      type: "image_url",
      image_url: {
        url: "https://storage.uploads.sh/cdn-cgi/image/width=1280,quality=82,fit=scale-down,format=jpeg,onerror=redirect/acme/shots/settings-slack.png",
      },
    });
    expect(model.requests.every((r) => r.tool_choice === "auto")).toBe(true);
  });

  it("drops filter values the classifier never writes", async () => {
    const model = scripted([
      {
        content: null,
        tool_calls: [call("c1", "search_files", { screen: "billing", query: "plan" })],
      },
      { content: "Nothing yet.", tool_calls: [] },
    ]);
    const search = vi.fn(async () => ({ bound: true, results: [], truncated: false }));
    await answerQuestion(
      { question: "billing?", context: [] },
      { complete: model.complete, search },
    );
    expect(search).toHaveBeenCalledWith("plan", {});
  });

  it("falls back to the last search's files when the model stops answering", async () => {
    const model = scripted([
      { content: null, tool_calls: [call("c1", "search_files", { screen: "settings" })] },
      null,
    ]);
    const answer = await answerQuestion(
      { question: "settings?", context: [] },
      { complete: model.complete, search: async () => SETTINGS },
    );
    expect(answer.answered).toBe(false);
    expect(answer.files).toEqual(SETTINGS.results);
  });

  it("forces a reply once the deadline passes", async () => {
    let clock = 0;
    const model = scripted([
      { content: null, tool_calls: [call("c1", "search_files", { screen: "settings" })] },
      { content: null, tool_calls: [call("c2", "reply", { text: "Here.", file_ids: ["f1"] })] },
    ]);
    const answer = await answerQuestion(
      { question: "settings?", context: [] },
      {
        complete: async (r) => {
          clock += 30_000;
          return model.complete(r);
        },
        search: async () => SETTINGS,
        now: () => clock,
      },
    );
    expect(model.requests[1]!.tool_choice).toEqual({
      type: "function",
      function: { name: "reply" },
    });
    expect(answer.files).toEqual([SETTINGS.results[0]]);
  });

  it("sends a reply back once to look at images it only knows by filename", async () => {
    const model = scripted([
      { content: null, tool_calls: [call("c1", "search_files", { screen: "settings" })] },
      { content: null, tool_calls: [call("c2", "reply", { text: "Here.", file_ids: ["f1"] })] },
      { content: null, tool_calls: [call("c3", "look_at_files", { ids: ["f1"] })] },
      {
        content: null,
        tool_calls: [call("c4", "reply", { text: "Slack settings.", file_ids: ["f1"] })],
      },
    ]);
    const answer = await answerQuestion(
      { question: "settings?", context: [] },
      { complete: model.complete, search: async () => SETTINGS },
    );
    expect(model.requests[2]!.messages.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "c2",
      content: "Not sent. Call look_at_files on f1 first, then reply.",
    });
    expect(answer).toEqual({
      text: "Slack settings.",
      files: [SETTINGS.results[0]],
      answered: true,
    });
  });

  it("shows the same image once when it was uploaded to two folders", async () => {
    const copy = { ...SETTINGS.results[0]!, key: "pull/12/settings-slack.png" };
    const model = scripted([
      { content: null, tool_calls: [call("c1", "search_files", { screen: "settings" })] },
      { content: null, tool_calls: [call("c2", "look_at_files", { ids: ["f1", "f3"] })] },
      {
        content: null,
        tool_calls: [call("c3", "reply", { text: "One.", file_ids: ["f1", "f3"] })],
      },
    ]);
    const answer = await answerQuestion(
      { question: "settings?", context: [] },
      {
        complete: model.complete,
        search: async () => ({ ...SETTINGS, results: [...SETTINGS.results, copy] }),
      },
    );
    expect(answer.files).toEqual([SETTINGS.results[0]]);
  });

  it("says so when search isn't on for the Slack workspace", async () => {
    const model = scripted([
      { content: null, tool_calls: [call("c1", "search_files", { query: "login" })] },
    ]);
    const answer = await answerQuestion(
      { question: "login?", context: [] },
      {
        complete: model.complete,
        search: async () => ({ bound: false, results: [], truncated: false }),
      },
    );
    expect(answer.text).toContain("Settings → Slack");
    expect(model.requests).toHaveLength(1);
  });
});

describe("questionText", () => {
  it("drops the app's own mention and unescapes Slack text", () => {
    expect(questionText("<@UBOT> any shots of <@UALICE>&apos;s page &amp; login?", "UBOT")).toBe(
      "any shots of <@UALICE>&apos;s page & login?",
    );
    expect(questionText("  <@UBOT>   recent settings  ")).toBe("recent settings");
  });
});

describe("lookUrl", () => {
  it("leaves other hosts alone", () => {
    expect(lookUrl("https://cdn.example/a.png")).toBe("https://cdn.example/a.png");
  });
});

describe("app_mention", () => {
  let sqlite: SqliteD1 | null = null;
  afterEach(() => {
    sqlite?.close();
    sqlite = null;
  });

  async function setup(overrides: Partial<SlackEnv> = {}) {
    sqlite = new SqliteD1([
      "migrations/20261018160000_slack_installations.sql",
      "migrations/20261019210000_platform_settings.sql",
    ]);
    const apiCalls: Record<string, unknown>[] = [];
    const env: SlackEnv = {
      WEB_ORIGIN: "https://uploads.sh",
      SLACK_APP_ID: "A1",
      SLACK_TOKENS_KEY: KEY,
      SLACK_SIGNING_SECRET: SECRET,
      OPENROUTER_API_KEY: "sk-or-test",
      DB: database(sqlite),
      API: {
        fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
          apiCalls.push(JSON.parse(String(init?.body ?? "{}")));
          return Response.json(SETTINGS);
        }),
      } as unknown as Fetcher,
      ...overrides,
    };
    await saveInstall(env.DB!, KEY, {
      teamId: "T1",
      teamName: "Acme",
      enterpriseId: null,
      appId: "A1",
      botUserId: "UBOT",
      botToken: "xoxb-acme",
      scopes: "app_mentions:read,channels:history,chat:write,reactions:write,users:read",
      installedBySlackUserId: "U1",
    });
    return { env, apiCalls };
  }

  /** Records every Slack call; users.info answers with `user`. */
  function fakeSlack(user: Record<string, unknown>) {
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = String(input).split("/").at(-1)!;
      const raw = String(init?.body ?? "");
      const body = raw.startsWith("{")
        ? JSON.parse(raw)
        : Object.fromEntries(new URLSearchParams(raw));
      calls.push({ method, body });
      if (method === "users.info") return Response.json({ ok: true, user });
      if (method === "conversations.replies") {
        return Response.json({
          ok: true,
          messages: [
            { ts: "100.1", user: "U0ALICE", text: "The new settings page is up" },
            { ts: "100.2", app_id: "A1", bot_id: "B1", text: "Two settings screenshots." },
            { ts: "100.3", user: "U0ALICE", text: "<@UBOT> just the mobile ones" },
          ],
        });
      }
      return Response.json({ ok: true });
    }) as unknown as typeof globalThis.fetch;
    return { fetch, calls };
  }

  /** OpenRouter answering with one search, a look, then a reply showing f2. */
  function fakeModel() {
    const bodies: Record<string, unknown>[] = [];
    const turns = [
      [call("c1", "search_files", { screen: "settings", surface: "mobile" })],
      [call("c2", "look_at_files", { ids: ["f1", "f2"] })],
      [call("c3", "reply", { text: "One mobile settings screenshot.", file_ids: ["f2"] })],
    ];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(OPENROUTER_CHAT_URL);
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        choices: [{ message: { content: null, tool_calls: turns.shift() } }],
      });
    }) as unknown as typeof globalThis.fetch;
    return { fetch, bodies };
  }

  async function mention(
    env: SlackEnv,
    slackFetch: typeof globalThis.fetch,
    modelFetch: typeof globalThis.fetch,
    event: Record<string, unknown>,
  ) {
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      authorizations: [{ user_id: "UBOT", is_bot: true }],
      event: { type: "app_mention", channel: "C1", user: "U0ALICE", ...event },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const pending: Promise<unknown>[] = [];
    const res = await createApp({ slackFetch, modelFetch }).fetch(
      new Request("https://agents.uploads.sh/slack/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slack-Request-Timestamp": timestamp,
          "X-Slack-Signature": await signSlackRequest(SECRET, timestamp, body),
        },
        body,
      }),
      env,
      {
        waitUntil: (p: Promise<unknown>) => pending.push(p),
        passThroughOnException() {},
        props: {},
      } as unknown as ExecutionContext,
    );
    await Promise.all(pending);
    return res;
  }

  const MEMBER = { id: "U0ALICE", team_id: "T1", is_restricted: false };

  it("answers in the thread with the thread as context, searching only through the binding", async () => {
    const { env, apiCalls } = await setup();
    const slack = fakeSlack(MEMBER);
    const model = fakeModel();
    const res = await mention(env, slack.fetch, model.fetch, {
      ts: "100.3",
      thread_ts: "100.1",
      text: "<@UBOT> just the mobile ones",
    });
    expect(res.status).toBe(200);
    expect(slack.calls.map((c) => c.method)).toEqual([
      "users.info",
      "reactions.add",
      "conversations.replies",
      "chat.postMessage",
      "reactions.remove",
    ]);
    // The model saw the thread, with its own earlier answer marked, and the bare question.
    const prompt = (model.bodies[0]!.messages as { content: string }[])[1]!.content;
    expect(prompt).toContain("<@U0ALICE>: The new settings page is up");
    expect(prompt).toContain("uploads.sh (you): Two settings screenshots.");
    expect(prompt).toContain("Question: just the mobile ones");
    expect(model.bodies[0]!.model).toBe("anthropic/claude-haiku-5.5");
    // The search went to the internal route for this Slack team.
    expect(apiCalls).toEqual([
      { teamId: "T1", term: "", labels: { screen: "settings", surface: "mobile" }, limit: 10 },
    ]);
    const posted = slack.calls.find((c) => c.method === "chat.postMessage")!.body;
    expect(posted).toMatchObject({
      channel: "C1",
      thread_ts: "100.1",
      text: "One mobile settings screenshot.",
    });
    const blocks = posted.blocks as { text?: { text: string } }[];
    expect(blocks).toHaveLength(2);
    expect(blocks[1]!.text!.text).toContain("https://uploads.sh/f/acme/shots/account.png");
  });

  it("runs the model an operator picked under Admin → Models", async () => {
    const { env } = await setup();
    sqlite!.db
      .prepare(
        "INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ('slack_agent_model', 'cheap/vision', 'Admin', '2026-10-19')",
      )
      .run();
    const model = fakeModel();
    await mention(env, fakeSlack(MEMBER).fetch, model.fetch, { ts: "5.1", text: "<@UBOT> hi" });
    expect(model.bodies[0]!.model).toBe("cheap/vision");
  });

  it("defaults to the same model the admin page shows", () => {
    expect(DEFAULT_AGENT_MODEL).toBe(SLACK_AGENT_DEFAULT_MODEL);
  });

  it("starts a thread on a top-level mention without reading history", async () => {
    const { env } = await setup();
    const slack = fakeSlack(MEMBER);
    await mention(env, slack.fetch, fakeModel().fetch, { ts: "200.1", text: "<@UBOT> settings?" });
    expect(slack.calls.map((c) => c.method)).not.toContain("conversations.replies");
    const posted = slack.calls.find((c) => c.method === "chat.postMessage")!.body;
    expect(posted.thread_ts).toBe("200.1");
  });

  it("ignores guests and bots", async () => {
    const { env, apiCalls } = await setup();
    const guest = fakeSlack({ ...MEMBER, is_restricted: true });
    const model = fakeModel();
    await mention(env, guest.fetch, model.fetch, { ts: "1.1", text: "<@UBOT> hi" });
    expect(guest.calls.map((c) => c.method)).toEqual(["users.info"]);
    const member = fakeSlack(MEMBER);
    await mention(env, member.fetch, model.fetch, { ts: "1.2", text: "hi", bot_id: "B9" });
    expect(member.calls).toEqual([]);
    expect(model.bodies).toEqual([]);
    expect(apiCalls).toEqual([]);
  });

  it("says it can't answer yet without a model key", async () => {
    const { env } = await setup({ OPENROUTER_API_KEY: "" });
    const slack = fakeSlack(MEMBER);
    await mention(env, slack.fetch, fakeModel().fetch, { ts: "3.1", text: "<@UBOT> hi" });
    const posted = slack.calls.find((c) => c.method === "chat.postMessage")!.body;
    expect(String(posted.text)).toContain("can't answer questions here yet");
  });
});
