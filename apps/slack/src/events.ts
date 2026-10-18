/**
 * Events API dispatch. Each Slack event type this app subscribes to gets one
 * entry in EVENT_HANDLERS; adding a feature that reacts to a new event means
 * adding its handler here and its event to manifest.json. Handlers run after
 * the 200 is sent (Slack retries anything slower than 3 seconds), so they
 * report outcomes through logs, not the response.
 */
import { botTokenFor, type SlackEnv } from "./config";
import type { EventCallbackPayload, LinkSharedEvent, SlackEvent } from "./slack/types";
import { handleLinkShared } from "./unfurl";

export interface HandlerContext {
  env: SlackEnv;
  teamId: string;
  /** Overridable for tests; defaults to global fetch. */
  slackFetch?: typeof globalThis.fetch;
}

type EventHandler = (event: SlackEvent, ctx: HandlerContext) => Promise<void>;

function webFetchFor(env: SlackEnv): typeof globalThis.fetch {
  const web = env.WEB;
  if (!web) return globalThis.fetch;
  return web.fetch.bind(web) as unknown as typeof globalThis.fetch;
}

const EVENT_HANDLERS: Record<string, EventHandler> = {
  async link_shared(event, ctx) {
    const botToken = botTokenFor(ctx.env, ctx.teamId);
    if (!botToken) {
      console.warn("slack.unfurl: no bot token for team", { team: ctx.teamId });
      return;
    }
    const outcome = await handleLinkShared(event as LinkSharedEvent, {
      webOrigin: ctx.env.WEB_ORIGIN || "https://uploads.sh",
      webFetch: webFetchFor(ctx.env),
      slackFetch: ctx.slackFetch,
      botToken,
    });
    if (outcome.status === "failed") {
      console.error("slack.unfurl: chat.unfurl failed", { error: outcome.error });
    } else {
      console.log("slack.unfurl", outcome);
    }
  },
};

/** True when this app has a handler for the event's type. */
export function handlesEvent(type: string): boolean {
  return Object.hasOwn(EVENT_HANDLERS, type);
}

/** Runs the handler for one event_callback. Unknown event types are ignored. */
export async function dispatchEvent(
  payload: EventCallbackPayload,
  ctx: Omit<HandlerContext, "teamId">,
): Promise<void> {
  const type = payload.event?.type;
  if (!type || !handlesEvent(type)) return;
  await EVENT_HANDLERS[type]!(payload.event, { ...ctx, teamId: payload.team_id });
}
