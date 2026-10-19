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
 */
import { answerQuestion, DEFAULT_AGENT_MODEL, openRouterComplete } from "./agent";
import { fileBlock, isFullMember, searchViaApi } from "./commands";
import { botTokenFor, type SlackEnv } from "./config";
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

  const target = { channel: event.channel, timestamp: event.ts, name: WORKING_REACTION };
  await reactionsAdd(target, slack);
  try {
    const context = event.thread_ts ? await threadContext(event, ctx.env.SLACK_APP_ID, slack) : [];
    const answer = await answerQuestion(
      { question: questionText(event.text ?? "", ctx.botUserId), context },
      {
        complete: openRouterComplete({
          apiKey,
          model: ctx.env.SLACK_AGENT_MODEL?.trim() || DEFAULT_AGENT_MODEL,
          fetch: ctx.modelFetch,
        }),
        search: (term, labels) =>
          searchViaApi(ctx.env, ctx.teamId, term, {
            ...(Object.keys(labels).length ? { labels } : {}),
            limit: 10,
          }),
      },
    );
    const webOrigin = ctx.env.WEB_ORIGIN || "https://uploads.sh";
    const showWorkspace = new Set(answer.files.map((f) => f.workspace)).size > 1;
    const blocks: Block[] = [
      { type: "section", text: { type: "mrkdwn", text: answer.text } },
      ...answer.files.map((f) => fileBlock(f, webOrigin, showWorkspace)),
    ];
    const posted = await post(answer.text, blocks);
    console.log("slack.mention", {
      answered: answer.answered,
      files: answer.files.length,
      posted: posted.ok,
      error: posted.error,
    });
  } finally {
    await reactionsRemove(target, slack);
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
