/**
 * GitHub App webhook endpoint (POST /v1/github/webhook, phase 2 PR A).
 * Unauthenticated by session/bearer — the X-Hub-Signature-256 HMAC is the auth
 * boundary. Must be mounted BEFORE the `/v1/:workspace/*` guard in index.ts
 * (see that file): the guard pattern matches this two-segment path, so ordering
 * (route handler returns without next()) is what keeps workspaceAuth from
 * running. Reads the raw body and verifies before parsing JSON.
 */
import { Hono } from "hono";
import { handleWebhook, verifySignature } from "../github-webhook";
import type { WorkspaceVars } from "../workspace";

export const githubWebhook = new Hono<WorkspaceVars>();

githubWebhook.post("/", async (c) => {
  const secret = c.env.GITHUB_APP_WEBHOOK_SECRET;
  if (!secret) return c.body(null, 503); // honest "not configured"; never pretend to process.

  const raw = await c.req.text();
  if (!(await verifySignature(raw, c.req.header("x-hub-signature-256") ?? null, secret))) {
    return c.body(null, 401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    // An unparseable body that already passed HMAC is a no-op — GitHub retries
    // non-2xx and there is nothing to invalidate.
    return c.body(null, 204);
  }

  await handleWebhook(c.env, c.req.header("x-github-event") ?? "", payload);
  return c.body(null, 204);
});
