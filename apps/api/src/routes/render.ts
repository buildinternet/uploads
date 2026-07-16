/**
 * POST /v1/render (phase 1, see .context/2026-07-16-render-endpoint-brief.md):
 * renders a URL or raw HTML to a PNG via the Browser Run binding and returns
 * the bytes directly (no R2 write — the CLI uploads through the existing put
 * path). Registered before the `/v1/:workspace/*` guard in src/index.ts, so
 * (like /v1/tokens and /v1/workspaces) it brings its own auth — here,
 * `tokenWorkspaceAuth`, which resolves the workspace from the token itself
 * rather than a path segment.
 *
 * Quota: renders draw against the *existing* monthly upload budget
 * (`maxUploadsPerPeriod`) — no new ledger. The upload is reserved atomically
 * in D1 (`reserveUploads`) BEFORE the paid Browser Run call and released if
 * the render fails, so concurrent requests at the cap boundary cannot all
 * pass a read-then-check and overshoot the cap. A burst limiter
 * (`RENDER_LIMITER`) additionally guards against a hot loop within a single
 * window, independent of the monthly cap.
 */
import { Hono } from "hono";
import { budgetDenialError, resolveBudgetLimits, uploadBudgetDenial } from "../budget";
import { readJsonObjectBody } from "../cli-intake";
import { renderRateLimit } from "../guards";
import { browserRenderer, MAX_RENDER_HTML_BYTES, parseRenderRequest } from "../render";
import { releaseUploadsSafe, reserveUploads } from "../usage";
import { requireScope, tokenWorkspaceAuth, type WorkspaceVars } from "../workspace";

// Headroom over the 2 MiB `html` cap for JSON-encoding overhead (escaped
// backslashes/unicode, the surrounding object). Checked (via
// readJsonObjectBody's declared-Content-Length short-circuit and buffered-size
// check) before JSON.parse so an oversized payload never reaches the parser —
// same shape as the body-size guard the other CLI/MCP intake routes use
// (`/v1/telemetry`, `/v1/reports`). The exact 2 MiB `html` field cap is
// re-checked inside `parseRenderRequest`.
const MAX_BODY_BYTES = MAX_RENDER_HTML_BYTES + 1024 * 1024;

export const render = new Hono<WorkspaceVars>().post(
  "/",
  tokenWorkspaceAuth,
  requireScope("files:write"),
  renderRateLimit,
  async (c) => {
    const parsed = await readJsonObjectBody(c.req.raw, MAX_BODY_BYTES);
    const input = parseRenderRequest(parsed);

    const workspaceName = c.get("workspaceName");
    const ws = c.get("workspace");

    // Renders never move stored bytes, so only the monthly upload budget
    // applies (this deliberately reuses the put budget, not a render-specific
    // ledger). Reserve the upload atomically before the metered Browser Run
    // call; the reservation IS the count, so success records nothing further
    // and failure releases it.
    const { maxUploadsPerPeriod } = resolveBudgetLimits(ws);
    const reservation = await reserveUploads(c.env.DB, workspaceName, 1, maxUploadsPerPeriod);
    if (!reservation.ok) {
      throw budgetDenialError(
        uploadBudgetDenial(reservation.usage, reservation.maxUploadsPerPeriod),
      );
    }

    let result;
    try {
      result = await browserRenderer(c.env.BROWSER).screenshot(input);
    } catch (err) {
      await releaseUploadsSafe(c.env.DB, workspaceName, 1);
      throw err;
    }

    return new Response(result.png, {
      status: 200,
      headers: { "Content-Type": result.contentType || "image/png" },
    });
  },
);
