/**
 * @uploads.sh mentions: someone asks a question in a channel, and the app
 * answers in that message's thread (agent.ts does the thinking).
 *
 * Who it answers, same as `/uploads search`: full members of a Slack
 * workspace whose uploads.sh admin turned on search under Settings → Slack.
 * Guests, people from other organizations, and bots get nothing back. What
 * it can find: public files in the uploads.sh workspaces bound to this
 * Slack team, never any other workspace, even a public one.
 *
 * One answer per mention. In a thread it reads the thread first (up to
 * THREAD_MAX messages, with `channels:history` / `groups:history`), so a
 * follow-up like "just the mobile ones" builds on the last answer. Without
 * those scopes it answers the mention alone.
 *
 * Every answer is a billed model run, so each Slack workspace gets a daily
 * number of answers (UTC, counted in `slack_agent_usage`) set by the highest
 * plan among its bound uploads.sh workspaces (uploads-api's
 * `/internal/slack/plan`); past that it says so instead. When something
 * fails, the thread still gets a reply saying what happened.
 *
 * Each mention is one `invoke_agent` trace span (tracing.ts). Its
 * conversation id is the Slack thread, so a thread's mentions group together
 * in the Agents dashboard, and its agent id is the Slack team.
 */
import { answerQuestion, DEFAULT_AGENT_MODEL, openRouterComplete } from "./agent";
import { fileBlock, isFullMember, largeFileBlocks, searchViaApi } from "./commands";
import { botTokenFor, type SlackEnv } from "./config";
import { inSpan } from "./tracing";
import {
  chatPostMessage,
  conversationsReplies,
  reactionsAdd,
  reactionsRemove,
  type Block,
  type SlackApiOptions,
} from "./slack/api";
import type { AppMentionEvent } from "./slack/types";

/** Thread messages read for context, the parent included. */
const THREAD_MAX = 20;
/** Characters kept from each context message. */
const CONTEXT_CHARS = 500;
const WORKING_REACTION = "eyes";
/** Answers showing this many files or fewer show each image full width. */
const LARGE_FILES_MAX = 2;
/** `gen_ai.agent.name` on the mention agent's spans. */
const AGENT_NAME = "uploads.sh Slack";

/** The mention text without the app's own @-name, with Slack's escapes undone. */
export function questionText(text: string, botUserId?: string): string {
  let out = text;
  if (botUserId) out = out.split(`<@${botUserId}>`).join(" ");
  else out = out.replace(/^\s*<@[UW][A-Z0-9]+>/, " ");
  return out
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export async function handleMention(
  event: AppMentionEvent,
  ctx: {
    env: SlackEnv;
    teamId: string;
    botUserId?: string;
    slackFetch?: typeof globalThis.fetch;
    /** Overrides the model fetch (tests). */
    modelFetch?: typeof globalThis.fetch;
  },
): Promise<void> {
  if (event.subtype || event.bot_id || !event.user || !event.channel || !event.ts) return;
  const token = await botTokenFor(ctx.env, ctx.teamId);
  if (!token) return;
  const slack: SlackApiOptions = { token, fetch: ctx.slackFetch };
  const fetchImpl = ctx.slackFetch ?? globalThis.fetch;
  const threadTs = event.thread_ts ?? event.ts;
  const post = (text: string, blocks?: Block[]) =>
    chatPostMessage(
      {
        channel: event.channel,
        thread_ts: threadTs,
        text,
        blocks: blocks ?? [{ type: "section", text: { type: "mrkdwn", text } }],
      },
      slack,
    );

  if (!(await isFullMember(ctx.teamId, event.user, token, fetchImpl))) {
    console.log("slack.mention: not a full member", { team: ctx.teamId });
    return;
  }
  const apiKey = ctx.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    console.warn("slack.mention: OPENROUTER_API_KEY unset");
    await post("I can't answer questions here yet. `/uploads search <filename>` still works.");
    return;
  }

  const [used, limit] = await Promise.all([
    countMention(ctx.env, ctx.teamId, new Date()),
    dailyLimit(ctx.env, ctx.teamId),
  ]);
  if (used !== null && limit && used > limit.answersPerDay) {
    console.warn("slack.mention: daily limit reached", { team: ctx.teamId, used, ...limit });
    const upgrade = limit.plan === "free" ? " Pro workspaces get more." : "";
    await post(
      `This Slack workspace has used today's ${limit.answersPerDay} questions.${upgrade} I can answer again tomorrow (UTC). \`/uploads search <filename>\` still works.`,
    );
    return;
  }

  const model = await agentModel(ctx.env);
  const identity = {
    "gen_ai.agent.name": AGENT_NAME,
    "gen_ai.agent.id": ctx.teamId,
    "gen_ai.conversation.id": `${ctx.teamId}:${event.channel}:${threadTs}`,
  };
  const target = { channel: event.channel, timestamp: event.ts, name: WORKING_REACTION };
  await reactionsAdd(target, slack);
  try {
    const context = event.thread_ts ? await threadContext(event, ctx.env.SLACK_APP_ID, slack) : [];
    const invoke = {
      ...identity,
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.request.model": model,
    };
    const answer = await inSpan(`invoke_agent ${AGENT_NAME}`, invoke, async (span) => {
      const result = await answerQuestion(
        { question: questionText(event.text ?? "", ctx.botUserId), context },
        {
          complete: openRouterComplete({
            apiKey,
            model,
            fetch: ctx.modelFetch,
            identity,
          }),
          search: (term, labels) =>
            searchViaApi(ctx.env, ctx.teamId, term, {
              ...(Object.keys(labels).length ? { labels } : {}),
              limit: 10,
            }),
        },
      );
      span.setAttributes({
        "gen_ai.usage.input_tokens": result.usage.inputTokens,
        "gen_ai.usage.output_tokens": result.usage.outputTokens,
        "openrouter.cost_usd": result.usage.costUsd,
        "uploads.answered": result.answered,
        "uploads.files": result.files.length,
      });
      return result;
    });
    const webOrigin = ctx.env.WEB_ORIGIN || "https://uploads.sh";
    const showWorkspace = new Set(answer.files.map((f) => f.workspace)).size > 1;
    // One or two images read better full width; more stay a compact list.
    const large = answer.files.length <= LARGE_FILES_MAX;
    const blocks: Block[] = [
      { type: "section", text: { type: "mrkdwn", text: answer.text } },
      ...answer.files.flatMap((f) =>
        large
          ? largeFileBlocks(f, webOrigin, showWorkspace)
          : [fileBlock(f, webOrigin, showWorkspace)],
      ),
    ];
    const posted = await post(answer.text, blocks);
    console.log("slack.mention", {
      model,
      answered: answer.answered,
      files: answer.files.length,
      calls: answer.usage.calls,
      input_tokens: answer.usage.inputTokens,
      output_tokens: answer.usage.outputTokens,
      cost_usd: answer.usage.costUsd,
      model_error: answer.error,
      posted: posted.ok,
      error: posted.error,
    });
  } catch (err) {
    console.error("slack.mention: failed", { team: ctx.teamId, err: String(err) });
    await post(
      "Something went wrong while I was looking. Try again, or use `/uploads search <filename>`.",
    ).catch(() => {});
  } finally {
    await reactionsRemove(target, slack);
  }
}

/**
 * Adds this mention to the team's count for the day and returns the new
 * count, or null when the count can't be read (then the mention goes ahead).
 */
export async function countMention(
  env: SlackEnv,
  teamId: string,
  now: Date,
): Promise<number | null> {
  if (!env.DB) return null;
  try {
    const row = await env.DB.prepare(
      `INSERT INTO slack_agent_usage (team_id, day, mentions) VALUES (?, ?, 1)
       ON CONFLICT (team_id, day) DO UPDATE SET mentions = mentions + 1
       RETURNING mentions`,
    )
      .bind(teamId, now.toISOString().slice(0, 10))
      .first<{ mentions: number }>();
    return row?.mentions ?? null;
  } catch (err) {
    console.error("slack.mention: usage count failed", { err: String(err) });
    return null;
  }
}

/**
 * The team's answers a day and the plan behind it, from uploads-api, or null
 * when that can't be read (then the mention goes ahead).
 */
export async function dailyLimit(
  env: SlackEnv,
  teamId: string,
): Promise<{ plan: string; answersPerDay: number } | null> {
  if (!env.API) return null;
  try {
    const res = await env.API.fetch("https://api.internal/internal/slack/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamId }),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = (await res.json()) as { plan?: unknown; answersPerDay?: unknown };
    if (typeof body.answersPerDay !== "number") throw new Error("bad shape");
    return { plan: String(body.plan), answersPerDay: body.answersPerDay };
  } catch (err) {
    console.error("slack.mention: plan read failed", { err: String(err) });
    return null;
  }
}

/**
 * The model an operator picked under Admin → Models (`platform_settings`,
 * written by uploads-api), or the default when none is set or the read fails.
 */
export async function agentModel(env: SlackEnv): Promise<string> {
  if (!env.DB) return DEFAULT_AGENT_MODEL;
  try {
    const row = await env.DB.prepare("SELECT value FROM platform_settings WHERE key = ?")
      .bind("slack_agent_model")
      .first<{ value: string }>();
    return row?.value?.trim() || DEFAULT_AGENT_MODEL;
  } catch (err) {
    console.error("slack.mention: model setting read failed", { err: String(err) });
    return DEFAULT_AGENT_MODEL;
  }
}

/** The thread before this mention, one line per message, oldest first. */
async function threadContext(
  event: AppMentionEvent,
  appId: string | undefined,
  slack: SlackApiOptions,
): Promise<string[]> {
  const messages = await conversationsReplies(
    { channel: event.channel, ts: event.thread_ts!, limit: THREAD_MAX },
    slack,
  );
  return messages
    .filter((m) => m.ts !== event.ts && m.text?.trim())
    .map((m) => {
      const who =
        appId && m.app_id === appId ? "uploads.sh (you)" : m.user ? `<@${m.user}>` : "a bot";
      return `${who}: ${m.text!.trim().slice(0, CONTEXT_CHARS)}`;
    });
}
