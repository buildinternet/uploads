/**
 * Events API dispatch. Each Slack event type this app subscribes to gets one
 * entry in EVENT_HANDLERS; adding a feature that reacts to a new event means
 * adding its handler here and its event to manifest.json. Handlers run after
 * the 200 is sent (Slack retries anything slower than 3 seconds), so they
 * report outcomes through logs, not the response.
 */
import { botTokenFor, type SlackEnv } from "./config";
import { parseHosts, presentDetails } from "./entities";
import { publishHome } from "./home";
import { handleMention } from "./mentions";
import { revokeInstall } from "./installs";
import type {
  AppHomeOpenedEvent,
  AppMentionEvent,
  EntityDetailsRequestedEvent,
  EventCallbackPayload,
  LinkSharedEvent,
  SlackEvent,
  TokensRevokedEvent,
} from "./slack/types";
import { handleLinkShared } from "./unfurl";

export interface HandlerContext {
  env: SlackEnv;
  teamId: string;
  /** The app's own bot user in this workspace, from the payload's authorizations. */
  botUserId?: string;
  /** Overridable for tests; defaults to global fetch. */
  slackFetch?: typeof globalThis.fetch;
  /** Overrides the mention agent's model fetch (tests). */
  modelFetch?: typeof globalThis.fetch;
}

type EventHandler = (event: SlackEvent, ctx: HandlerContext) => Promise<void>;

export function apiFetchFor(env: SlackEnv): typeof globalThis.fetch {
  const api = env.API;
  if (!api) return globalThis.fetch;
  return api.fetch.bind(api) as unknown as typeof globalThis.fetch;
}

/** Where share-link data comes from (uploads-api's public endpoints), and which image hosts Slack may open full size. */
export function shareDeps(env: SlackEnv) {
  return {
    webOrigin: env.WEB_ORIGIN || "https://uploads.sh",
    apiOrigin: env.API_ORIGIN || "https://api.uploads.sh",
    apiFetch: apiFetchFor(env),
    fullSizeHosts: parseHosts(env.SLACK_FULL_SIZE_HOSTS),
    iconBase: `${(env.SLACK_ORIGIN || "https://agents.uploads.sh").replace(/\/+$/, "")}/slack/icons`,
  };
}

const EVENT_HANDLERS: Record<string, EventHandler> = {
  async link_shared(event, ctx) {
    const botToken = await botTokenFor(ctx.env, ctx.teamId);
    if (!botToken) {
      console.warn("slack.unfurl: no bot token for team", { team: ctx.teamId });
      return;
    }
    const outcome = await handleLinkShared(event as LinkSharedEvent, {
      ...shareDeps(ctx.env),
      slackFetch: ctx.slackFetch,
      botToken,
      workObjects: ctx.env.SLACK_WORK_OBJECTS === "on",
    });
    if (outcome.status === "failed") {
      console.error("slack.unfurl: chat.unfurl failed", { error: outcome.error });
    } else {
      console.log("slack.unfurl", outcome);
    }
  },

  // A Work Object flexpane opened: fill it (entities.ts).
  async entity_details_requested(event, ctx) {
    const { trigger_id, app_unfurl_url, entity_url, link } = event as EntityDetailsRequestedEvent;
    const url = app_unfurl_url || entity_url || link?.url;
    if (!trigger_id || !url) return;
    const botToken = await botTokenFor(ctx.env, ctx.teamId);
    if (!botToken) return;
    const outcome = await presentDetails(
      { triggerId: trigger_id, link: url },
      {
        ...shareDeps(ctx.env),
        slack: { token: botToken, fetch: ctx.slackFetch },
      },
    );
    console.log("slack.work_objects: details", { outcome });
  },

  async app_home_opened(event, ctx) {
    const { user, tab } = event as AppHomeOpenedEvent;
    if (tab !== "home" || !user) return;
    const botToken = await botTokenFor(ctx.env, ctx.teamId);
    if (!botToken) return;
    await publishHome({
      env: ctx.env,
      teamId: ctx.teamId,
      slackUserId: user,
      botToken,
      slackFetch: ctx.slackFetch,
    });
  },

  // Someone @-mentioned the app: answer in the thread (mentions.ts).
  async app_mention(event, ctx) {
    await handleMention(event as AppMentionEvent, ctx);
  },

  // Uninstalls and token revocations drop the stored token.
  async app_uninstalled(_event, ctx) {
    if (!ctx.env.DB) return;
    await revokeInstall(ctx.env.DB, ctx.teamId);
    console.log("slack.install: uninstalled", { team: ctx.teamId });
  },

  async tokens_revoked(event, ctx) {
    const bots = (event as TokensRevokedEvent).tokens?.bot ?? [];
    if (!ctx.env.DB || bots.length === 0) return;
    await revokeInstall(ctx.env.DB, ctx.teamId);
    console.log("slack.install: bot token revoked", { team: ctx.teamId });
  },
};

/** Runs the handler for one event_callback. Unknown event types are ignored. */
export async function dispatchEvent(
  payload: EventCallbackPayload,
  ctx: Omit<HandlerContext, "teamId">,
): Promise<void> {
  const type = payload.event?.type;
  if (!type || !Object.hasOwn(EVENT_HANDLERS, type)) return;
  const botUserId = payload.authorizations?.find((a) => a.is_bot)?.user_id;
  await EVENT_HANDLERS[type]!(payload.event, { ...ctx, teamId: payload.team_id, botUserId });
}
