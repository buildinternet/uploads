/**
 * The app's Home tab: where a Slack user connects their uploads.sh account.
 *
 * Unlinked users see a Connect button that carries a fresh single-use
 * ticket to uploads.sh/slack/connect (links.ts). Linked users see which
 * account they're connected to and a Disconnect button, handled by the
 * interactivity endpoint.
 */
import type { SlackEnv } from "./config";
import { findLink, mintTicket, removeLink, teamName } from "./links";
import { slackDisplayName, viewsPublish, type Block } from "./slack/api";

export const DISCONNECT_ACTION = "uploads_disconnect";
export const CONNECT_ACTION = "uploads_connect";

const SETTINGS_URL = "https://uploads.sh/account/profile#slack";

/**
 * The linked state names no uploads.sh account on purpose: if someone was
 * tricked into connecting another person's Slack user to their account
 * (by following a forwarded Connect link), this tab must not reveal whose
 * account it is. The date lets the real owner spot a link they didn't make.
 */
export function linkedHome(linkedAt: string): Block[] {
  const seconds = Math.floor(Date.parse(linkedAt) / 1000);
  const when = Number.isFinite(seconds)
    ? ` on <!date^${seconds}^{date_short}|${linkedAt.slice(0, 10)}>`
    : "";
  return [
    { type: "header", text: { type: "plain_text", text: "uploads.sh" } },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Your Slack account was connected to an uploads.sh account${when}. Didn't do this? Disconnect.`,
      },
      accessory: {
        type: "button",
        action_id: DISCONNECT_ACTION,
        text: { type: "plain_text", text: "Disconnect" },
        confirm: {
          title: { type: "plain_text", text: "Disconnect uploads.sh?" },
          text: { type: "plain_text", text: "You can connect again from this tab." },
          confirm: { type: "plain_text", text: "Disconnect" },
          deny: { type: "plain_text", text: "Cancel" },
        },
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Held-upload messages arrive in this app's Messages tab. Turn them off in <${SETTINGS_URL}|uploads.sh notification settings>. Link previews work for everyone, connected or not.`,
        },
      ],
    },
  ];
}

export function unlinkedHome(connectUrl: string): Block[] {
  return [
    { type: "header", text: { type: "plain_text", text: "uploads.sh" } },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Connect your uploads.sh account to get a message here when one of your uploads is held for review, and approve it from Slack.",
      },
      accessory: {
        type: "button",
        action_id: CONNECT_ACTION,
        style: "primary",
        text: { type: "plain_text", text: "Connect uploads.sh" },
        url: connectUrl,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "The button works once, for 30 minutes. Link previews work for everyone, connected or not.",
        },
      ],
    },
  ];
}

export interface HomeContext {
  env: SlackEnv;
  teamId: string;
  slackUserId: string;
  botToken: string;
  slackFetch?: typeof globalThis.fetch;
}

/** Renders and publishes the Home tab for one user. */
export async function publishHome(ctx: HomeContext): Promise<void> {
  const db = ctx.env.DB;
  if (!db) return;
  const link = await findLink(db, ctx.teamId, ctx.slackUserId);
  let blocks: Block[];
  if (link) {
    blocks = linkedHome(link.linkedAt);
  } else {
    const ticket = await mintTicket(db, {
      teamId: ctx.teamId,
      teamName: await teamName(db, ctx.teamId),
      slackUserId: ctx.slackUserId,
      slackUserName: await slackDisplayName(ctx.slackUserId, {
        token: ctx.botToken,
        fetch: ctx.slackFetch,
      }),
    });
    const url = new URL("/slack/connect", ctx.env.WEB_ORIGIN || "https://uploads.sh");
    url.searchParams.set("ticket", ticket);
    blocks = unlinkedHome(url.href);
  }
  const result = await viewsPublish(
    ctx.slackUserId,
    { type: "home", blocks },
    { token: ctx.botToken, fetch: ctx.slackFetch },
  );
  if (!result.ok) console.error("slack.home: views.publish failed", { error: result.error });
}

/** Disconnect button: remove the link, then re-render so the Connect button appears. */
export async function disconnect(ctx: HomeContext): Promise<void> {
  if (!ctx.env.DB) return;
  await removeLink(ctx.env.DB, ctx.teamId, ctx.slackUserId);
  console.log("slack.link: disconnected", { team: ctx.teamId });
  await publishHome(ctx);
}
