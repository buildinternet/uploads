/**
 * Slack app for uploads.sh, served at agents.uploads.sh/slack/* (a route in
 * front of the uploads-mcp Custom Domain; see wrangler.jsonc).
 *
 * It unfurls uploads.sh share links in any workspace that installs it. The
 * layout leaves room for what comes next without reshaping this file:
 *   - GET  /slack/install    "Add to Slack" (OAuth v2; see oauth.ts)
 *   - GET  /slack/oauth/callback
 *   - POST /slack/events     Events API (link_shared, app_home_opened,
 *                            app_uninstalled, tokens_revoked; see events.ts)
 *   - POST /slack/interactivity  Home tab buttons (Disconnect; see home.ts)
 *   - POST /slack/commands   slash commands, e.g. an agent search command
 *   - POST /slack/internal/* service-binding-only calls from uploads-api
 *                            (host slack.internal): Home refresh after a
 *                            connect today; flag and PII notifications later
 * Every public Slack-facing route verifies the request signature first.
 */
import { Hono, type Context } from "hono";
import { botTokenFor, type SlackEnv } from "./config";
import { dispatchEvent } from "./events";
import { DISCONNECT_ACTION, disconnect, publishHome } from "./home";
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
      // Interactivity: Home tab buttons. Connect is a URL button, so only
      // Disconnect needs handling; everything else is acked and ignored.
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
      .notFound((c) => c.json({ error: "not_found" }, 404))
  );
}

export default createApp();
