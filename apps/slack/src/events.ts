/**
 * Events API dispatch. Each Slack event type this app subscribes to gets one
 * entry in EVENT_HANDLERS; adding a feature that reacts to a new event means
 * adding its handler here and its event to manifest.json. Handlers run after
 * the 200 is sent (Slack retries anything slower than 3 seconds), so they
 * report outcomes through logs, not the response.
 */
import { botTokenFor, type SlackEnv } from "./config";
import { publishHome } from "./home";
import { revokeInstall } from "./installs";
import type {
  AppHomeOpenedEvent,
  EventCallbackPayload,
  LinkSharedEvent,
  SlackEvent,
  TokensRevokedEvent,
} from "./slack/types";
import { handleLinkShared } from "./unfurl";

export interface HandlerContext {
  env: SlackEnv;
  teamId: string;
  /** Overridable for tests; defaults to global fetch. */
  slackFetch?: typeof globalThis.fetch;
}

type EventHandler = (event: SlackEvent, ctx: HandlerContext) => Promise<void>;

function apiFetchFor(env: SlackEnv): typeof globalThis.fetch {
  const api = env.API;
  if (!api) return globalThis.fetch;
  return api.fetch.bind(api) as unknown as typeof globalThis.fetch;
}

const EVENT_HANDLERS: Record<string, EventHandler> = {
  async link_shared(event, ctx) {
    const botToken = await botTokenFor(ctx.env, ctx.teamId);
    if (!botToken) {
      console.warn("slack.unfurl: no bot token for team", { team: ctx.teamId });
      return;
    }
    const outcome = await handleLinkShared(event as LinkSharedEvent, {
      webOrigin: ctx.env.WEB_ORIGIN || "https://uploads.sh",
      apiOrigin: ctx.env.API_ORIGIN || "https://api.uploads.sh",
      apiFetch: apiFetchFor(ctx.env),
      slackFetch: ctx.slackFetch,
      botToken,
    });
    if (outcome.status === "failed") {
      console.error("slack.unfurl: chat.unfurl failed", { error: outcome.error });
    } else {
      console.log("slack.unfurl", outcome);
    }
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
  await EVENT_HANDLERS[type]!(payload.event, { ...ctx, teamId: payload.team_id });
}
