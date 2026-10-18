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
import { viewsPublish, type Block } from "./slack/api";

export const DISCONNECT_ACTION = "uploads_disconnect";
export const CONNECT_ACTION = "uploads_connect";

function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function linkedHome(userEmail: string | null): Block[] {
  const who = userEmail ? `*${escapeMrkdwn(userEmail)}*` : "your uploads.sh account";
  return [
    { type: "header", text: { type: "plain_text", text: "uploads.sh" } },
    {
      type: "section",
      text: { type: "mrkdwn", text: `Your Slack account is connected to ${who}.` },
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
      elements: [{ type: "mrkdwn", text: "Link previews work for everyone, connected or not." }],
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
        text: "Connect your uploads.sh account so the app knows who you are in this workspace.",
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
    blocks = linkedHome(link.userEmail);
  } else {
    const ticket = await mintTicket(db, {
      teamId: ctx.teamId,
      teamName: await teamName(db, ctx.teamId),
      slackUserId: ctx.slackUserId,
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
