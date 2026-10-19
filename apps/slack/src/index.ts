/**
 * Slack app for uploads.sh, served at agents.uploads.sh/slack/* (a route in
 * front of the uploads-mcp Custom Domain; see wrangler.jsonc).
 *
 * It unfurls uploads.sh share links in any workspace that installs it. The
 * layout leaves room for what comes next without reshaping this file:
 *   - GET  /slack/install    "Add to Slack" (OAuth v2; see oauth.ts)
 *   - GET  /slack/oauth/callback
 *   - POST /slack/events     Events API (link_shared, entity_details_requested,
 *                            app_home_opened, app_uninstalled,
 *                            tokens_revoked; see events.ts)
 *   - POST /slack/interactivity  buttons: Disconnect on the Home tab, the Share menu on search results
 *                            (home.ts), Approve / Keep held on a held-upload
 *                            DM (holds.ts), the pager in a Work Object
 *                            flexpane (entities.ts)
 *   - POST /slack/commands   slash commands, e.g. an agent search command
 *   - POST /slack/internal/* service-binding-only calls from uploads-api
 *                            (host slack.internal): Home refresh after a
 *                            connect, and held-upload DMs
 * Every public Slack-facing route verifies the request signature first.
 */
import { Hono, type Context } from "hono";
import { handleSlashCommand, parseSlashCommand, SHARE_ACTION, shareSearchResult } from "./commands";
import { botTokenFor, type SlackEnv } from "./config";
import { PAGE_NEXT_ACTION, PAGE_PREV_ACTION, presentDetails } from "./entities";
import { dispatchEvent, shareDeps } from "./events";
import { DISCONNECT_ACTION, disconnect, publishHome } from "./home";
import {
  HOLD_APPROVE_ACTION,
  HOLD_KEEP_ACTION,
  handleHoldAction,
  parseHoldNotice,
  sendHoldNotice,
} from "./holds";
import { handleCallback, handleInstall } from "./oauth";
import { verifySlackSignature } from "./slack/signature";
import type { BlockActionsPayload, EventsApiPayload } from "./slack/types";

type AppEnv = { Bindings: SlackEnv };

/** The host uploads-api's SLACK service binding addresses. */
const INTERNAL_HOST = "slack.internal";

/** Slack's documented request body cap is well under this; anything bigger isn't from Slack. */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Reads the raw body and checks Slack's signature. Returns the body on
 * success, or the error response to send.
 */
async function readSignedBody(c: Context<AppEnv>): Promise<string | Response> {
  const secret = c.env.SLACK_SIGNING_SECRET?.trim();
  // Fail closed: without the secret there is no way to tell Slack from anyone else.
  if (!secret) return c.json({ error: "slack_not_configured" }, 503);

  const declared = Number(c.req.header("Content-Length") ?? 0);
  if (declared > MAX_BODY_BYTES) return c.json({ error: "payload_too_large" }, 413);
  const rawBody = await c.req.text();
  if (rawBody.length > MAX_BODY_BYTES) return c.json({ error: "payload_too_large" }, 413);

  const valid = await verifySlackSignature({
    signingSecret: secret,
    timestamp: c.req.header("X-Slack-Request-Timestamp"),
    signature: c.req.header("X-Slack-Signature"),
    rawBody,
  });
  if (!valid) return c.json({ error: "invalid_signature" }, 401);
  return rawBody;
}

export interface AppOptions {
  /** Overrides the fetch used for slack.com calls (tests). */
  slackFetch?: typeof globalThis.fetch;
}

export function createApp(options: AppOptions = {}) {
  return (
    new Hono<AppEnv>()
      .get("/slack/health", (c) => c.json({ ok: true }))
      // "Add to Slack" for other workspaces; see oauth.ts.
      .get("/slack/install", handleInstall)
      .get("/slack/oauth/callback", (c) => handleCallback(c, { slackFetch: options.slackFetch }))
      .post("/slack/events", async (c) => {
        const body = await readSignedBody(c);
        if (body instanceof Response) return body;

        let payload: EventsApiPayload;
        try {
          payload = JSON.parse(body) as EventsApiPayload;
        } catch {
          return c.json({ error: "invalid_json" }, 400);
        }

        if (payload.type === "url_verification") {
          return c.json({ challenge: payload.challenge });
        }
        if (payload.type === "event_callback") {
          // Ack now and work after: Slack retries any event not acked within 3s.
          c.executionCtx.waitUntil(
            dispatchEvent(payload, { env: c.env, slackFetch: options.slackFetch }).catch((err) => {
              console.error("slack.events: handler threw", err);
            }),
          );
        }
        return c.body(null, 200);
      })
      // Interactivity. Connect is a URL button, so it needs no handling;
      // Disconnect, Approve, Keep held, Share, and the flexpane pager do. Anything
      // else is acked and ignored.
      .post("/slack/interactivity", async (c) => {
        const body = await readSignedBody(c);
        if (body instanceof Response) return body;
        let payload: BlockActionsPayload | null;
        try {
          payload = JSON.parse(new URLSearchParams(body).get("payload") ?? "null");
        } catch {
          return c.json({ error: "invalid_payload" }, 400);
        }
        const teamId = payload?.team?.id ?? payload?.user?.team_id;
        const slackUserId = payload?.user?.id;
        const wantsDisconnect =
          payload?.type === "block_actions" &&
          payload.actions?.some((action) => action.action_id === DISCONNECT_ACTION);
        const holdAction =
          payload?.type === "block_actions"
            ? payload.actions?.find(
                (action) =>
                  action.action_id === HOLD_APPROVE_ACTION || action.action_id === HOLD_KEEP_ACTION,
              )
            : undefined;
        // Newer/Older or Previous/Next in a feed or gallery flexpane.
        const pageAction =
          payload?.type === "block_actions" && payload.container?.type === "entity_detail"
            ? payload.actions?.find(
                (action) =>
                  action.action_id === PAGE_PREV_ACTION || action.action_id === PAGE_NEXT_ACTION,
              )
            : undefined;
        const pageLink = payload?.container?.app_unfurl_url || payload?.container?.entity_url;
        if (pageAction?.value && pageLink && payload?.trigger_id && teamId) {
          const triggerId = payload.trigger_id;
          c.executionCtx.waitUntil(
            (async () => {
              const botToken = await botTokenFor(c.env, teamId);
              if (!botToken) return;
              await presentDetails(
                { triggerId, link: pageLink, itemId: pageAction.value },
                { ...shareDeps(c.env), slack: { token: botToken, fetch: options.slackFetch } },
              );
            })().catch((err) => console.error("slack.interactivity: pager threw", err)),
          );
        }
        if (holdAction && teamId && slackUserId) {
          c.executionCtx.waitUntil(
            handleHoldAction(
              {
                actionId: holdAction.action_id,
                value: holdAction.value,
                teamId,
                slackUserId,
                responseUrl: payload?.response_url,
              },
              { env: c.env, slackFetch: options.slackFetch },
            ).catch((err) => console.error("slack.interactivity: hold action threw", err)),
          );
        }
        const shareAction =
          payload?.type === "block_actions"
            ? payload.actions?.find((action) => action.action_id === SHARE_ACTION)
            : undefined;
        if (shareAction && slackUserId) {
          c.executionCtx.waitUntil(
            shareSearchResult(
              {
                value: shareAction.selected_option?.value,
                slackUserId,
                responseUrl: payload?.response_url,
              },
              { env: c.env, slackFetch: options.slackFetch },
            ).catch((err) => console.error("slack.interactivity: share threw", err)),
          );
        }
        if (wantsDisconnect && teamId && slackUserId) {
          c.executionCtx.waitUntil(
            (async () => {
              const botToken = await botTokenFor(c.env, teamId);
              if (!botToken) return;
              await disconnect({
                env: c.env,
                teamId,
                slackUserId,
                botToken,
                slackFetch: options.slackFetch,
              });
            })().catch((err) => console.error("slack.interactivity: handler threw", err)),
          );
        }
        return c.body(null, 200);
      })
      .post("/slack/commands", async (c) => {
        const body = await readSignedBody(c);
        if (body instanceof Response) return body;
        const command = parseSlashCommand(body);
        if (!command) return c.json({ error: "invalid_command" }, 400);
        const { ack, work } = handleSlashCommand(command, {
          env: c.env,
          slackFetch: options.slackFetch,
        });
        if (work) {
          c.executionCtx.waitUntil(
            work.catch((err) => console.error("slack.commands: handler threw", err)),
          );
        }
        return c.json(ack);
      })
      // Service-binding only (uploads-api, after a connect or unlink): the
      // binding addresses slack.internal, while public traffic can only reach
      // this worker through the agents.uploads.sh route, so the host check
      // keeps it off the internet.
      .post("/slack/internal/home", async (c) => {
        if (new URL(c.req.url).hostname !== INTERNAL_HOST) {
          return c.json({ error: "not_found" }, 404);
        }
        let input: { teamId?: unknown; slackUserId?: unknown } | null = null;
        try {
          input = await c.req.json();
        } catch {
          return c.json({ error: "invalid_json" }, 400);
        }
        const teamId = typeof input?.teamId === "string" ? input.teamId : "";
        const slackUserId = typeof input?.slackUserId === "string" ? input.slackUserId : "";
        if (!/^[TE][A-Z0-9]{1,20}$/.test(teamId) || !/^[UW][A-Z0-9]{1,20}$/.test(slackUserId)) {
          return c.json({ error: "invalid_ids" }, 400);
        }
        const botToken = await botTokenFor(c.env, teamId);
        if (!botToken) return c.body(null, 204);
        await publishHome({
          env: c.env,
          teamId,
          slackUserId,
          botToken,
          slackFetch: options.slackFetch,
        });
        return c.body(null, 204);
      })
      // Service-binding only (uploads-api, when an upload is held): DM one
      // person about it. Same host guard as /slack/internal/home.
      .post("/slack/internal/hold", async (c) => {
        if (new URL(c.req.url).hostname !== INTERNAL_HOST) {
          return c.json({ error: "not_found" }, 404);
        }
        let input: unknown = null;
        try {
          input = await c.req.json();
        } catch {
          return c.json({ error: "invalid_json" }, 400);
        }
        const notice = parseHoldNotice(input, c.env.WEB_ORIGIN || "https://uploads.sh");
        if (!notice) return c.json({ error: "invalid_notice" }, 400);
        const sent = await sendHoldNotice(notice, { env: c.env, slackFetch: options.slackFetch });
        return sent ? c.body(null, 204) : c.json({ error: "not_delivered" }, 502);
      })
      .notFound((c) => c.json({ error: "not_found" }, 404))
  );
}

export default createApp();
