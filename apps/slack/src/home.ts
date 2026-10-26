/**
 * The app's Home tab: where a Slack user connects their uploads.sh account.
 *
 * Unlinked users see a Connect button that carries a fresh single-use
 * ticket to uploads.sh/slack/connect (links.ts). Linked users see which
 * account they're connected to and a Disconnect button, handled by the
 * interactivity endpoint. Either way, a workspace whose install is missing
 * scopes gets an Update permissions banner first, and everyone sees how to
 * use (or turn on) `/uploads search` at the bottom.
 */
import type { SlackEnv } from "./config";
import { installedScopes } from "./installs";
import { findLink, mintTicket, removeLink, teamName } from "./links";
import { canRun, missingFeaturesText } from "./scopes";
import { slackDisplayName, viewsPublish, type Block } from "./slack/api";

export const DISCONNECT_ACTION = "uploads_disconnect";
export const CONNECT_ACTION = "uploads_connect";
export const UPDATE_PERMISSIONS_ACTION = "uploads_update_permissions";

const SETTINGS_URL = "https://uploads.sh/account/profile#slack";
const WORKSPACES_URL = "https://uploads.sh/account/workspaces";

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

/**
 * Shown above everything else when the workspace's install lacks scopes the
 * current features need (scopes.ts). Slack only adds scopes when someone
 * runs the install again, so the button goes back to /slack/install.
 */
export function updatePermissionsBlocks(missingText: string, installUrl: string): Block[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `⚠️ *uploads.sh needs updated permissions in this workspace* for ${missingText}.`,
      },
      accessory: {
        type: "button",
        action_id: UPDATE_PERMISSIONS_ACTION,
        style: "primary",
        text: { type: "plain_text", text: "Update permissions" },
        url: installUrl,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Anyone who can add apps to this workspace can approve it on Slack's Allow page. Some workspaces send it to an admin first.",
        },
      ],
    },
    { type: "divider" },
  ];
}

/**
 * How to search from Slack. `workspaces` are the uploads.sh workspaces bound
 * to this Slack team (commands.ts); with none, explain who can turn it on.
 */
export function searchBlocks(workspaces: string[]): Block[] {
  const escape = (t: string) =>
    t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const section: Block =
    workspaces.length > 0
      ? {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Search*\nRun \`/uploads search <filename>\` in any conversation to find public files in ${workspaces.map((w) => `*${escape(w)}*`).join(", ")}. Only you see the results.`,
          },
        }
      : {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*Search*\nAn admin of an uploads.sh workspace can let everyone here find its public files with `/uploads search`. Turn it on under that workspace's *Settings → Slack*.",
          },
          accessory: {
            type: "button",
            text: { type: "plain_text", text: "Open uploads.sh" },
            url: WORKSPACES_URL,
          },
        };
  return [{ type: "divider" }, section];
}

/** uploads.sh workspaces bound to `teamId` (slack_workspace_bindings), sorted. */
async function boundWorkspaces(db: D1Database, teamId: string): Promise<string[]> {
  try {
    const { results } = await db
      .prepare(
        "SELECT workspace FROM slack_workspace_bindings WHERE team_id = ? ORDER BY workspace LIMIT 5",
      )
      .bind(teamId)
      .all<{ workspace: string }>();
    return results.map((r) => r.workspace);
  } catch (err) {
    console.error("slack.home: bindings lookup failed", { team: teamId, err: String(err) });
    return [];
  }
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
  const granted = await installedScopes(db, ctx.teamId);
  const missing = granted ? missingFeaturesText(granted) : null;
  if (granted && canRun(granted, "search")) {
    blocks = [...blocks, ...searchBlocks(await boundWorkspaces(db, ctx.teamId))];
  }
  if (missing) {
    const installUrl = `${(ctx.env.SLACK_ORIGIN || "https://agents.uploads.sh").replace(/\/+$/, "")}/slack/install`;
    blocks = [...updatePermissionsBlocks(missing, installUrl), ...blocks];
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
