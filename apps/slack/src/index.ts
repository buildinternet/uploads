/**
 * Slack app for uploads.sh, served at agents.uploads.sh/slack/* (a route in
 * front of the uploads-mcp Custom Domain; see wrangler.jsonc).
 *
 * v1 unfurls uploads.sh share links. The layout leaves room for what comes
 * next without reshaping this file:
 *   - POST /slack/events     Events API (link_shared today; see events.ts)
 *   - POST /slack/commands   slash commands, e.g. an agent search command
 *   - POST /slack/internal/* service-binding-only calls from uploads-api,
 *                            e.g. flag and PII hold notifications
 * Every public Slack-facing route verifies the request signature first.
 */
import { Hono, type Context } from "hono";
import type { SlackEnv } from "./config";
import { dispatchEvent } from "./events";
import { verifySlackSignature } from "./slack/signature";
import type { EventsApiPayload } from "./slack/types";

type AppEnv = { Bindings: SlackEnv };

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
  return new Hono<AppEnv>()
    .get("/slack/health", (c) => c.json({ ok: true }))
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
    .notFound((c) => c.json({ error: "not_found" }, 404));
}

export default createApp();
