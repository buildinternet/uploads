/**
 * GitHub App webhook endpoint (POST /v1/github/webhook, phase 2 PR A).
 * Unauthenticated by session/bearer — the X-Hub-Signature-256 HMAC is the auth
 * boundary. Must be mounted BEFORE the `/v1/:workspace/*` guard in index.ts
 * (see that file): the guard pattern matches this two-segment path, so ordering
 * (this handler returns/throws without calling next()) is what keeps
 * workspaceAuth from running. Reads the raw body and verifies before parsing
 * JSON. Failures throw the standard AppError subclasses so the shared
 * respondError path emits the usual `{ error: { code, type, message } }`
 * envelope (GitHub only reads the status code; the body is for our own logs).
 */
import { ServiceUnavailableError, UnauthorizedError } from "@uploads/errors";
import { Hono } from "hono";
import { handleWebhook, verifySignature } from "../github-webhook";
import type { WorkspaceVars } from "../workspace";

export const githubWebhook = new Hono<WorkspaceVars>();

githubWebhook.post("/", async (c) => {
  const secret = c.env.GITHUB_APP_WEBHOOK_SECRET;
  // Honest "not configured" (503); never pretend to process a delivery we can't verify.
  if (!secret) {
    throw new ServiceUnavailableError("webhook not configured", { code: "webhook_not_configured" });
  }

  const raw = await c.req.text();
  if (!(await verifySignature(raw, c.req.header("x-hub-signature-256") ?? null, secret))) {
    // One generic 401 for every signature failure (missing header, wrong
    // secret, tampered body) — don't reveal which check failed.
    throw new UnauthorizedError("invalid signature", { code: "invalid_signature" });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    // An unparseable body that already passed HMAC is a no-op — GitHub retries
    // non-2xx and there is nothing to invalidate.
    return c.body(null, 204);
  }

  // c.executionCtx throws when no platform ExecutionContext was supplied
  // (e.g. app.request(...) in tests without a 4th arg) — treat that as "no
  // waitUntil available" rather than let it escape as a 500.
  let executionCtx: Pick<ExecutionContext, "waitUntil"> | undefined;
  try {
    executionCtx = c.executionCtx;
  } catch {
    executionCtx = undefined;
  }

  await handleWebhook(c.env, c.req.header("x-github-event") ?? "", payload, executionCtx);
  return c.body(null, 204);
});
