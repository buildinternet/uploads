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
 * (`maxUploadsPerPeriod` / `checkPutBudget`) with a zero-byte delta — no new
 * ledger. A burst limiter (`RENDER_LIMITER`) additionally guards against a
 * hot loop within a single window, independent of the monthly cap.
 */
import { InsufficientStorageError, RateLimitedError } from "@uploads/errors";
import { Hono } from "hono";
import { checkPutBudget } from "../budget";
import { readJsonObjectBody } from "../cli-intake";
import { renderRateLimit } from "../guards";
import { browserRenderer, MAX_RENDER_HTML_BYTES, parseRenderRequest } from "../render";
import { getWorkspaceUsage, recordUsageSafe } from "../usage";
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

    // Renders never move stored bytes, so the delta is uploads-only — this
    // deliberately reuses the existing monthly upload budget (not a
    // render-specific ledger): checkPutBudget's storage-cap branch only
    // triggers on delta.bytes > 0, so a zero-byte delta here can only ever
    // trip maxUploadsPerPeriod.
    const usage = await getWorkspaceUsage(c.env.DB, workspaceName);
    const denial = checkPutBudget(usage, ws, { bytes: 0, uploads: 1 });
    if (denial) {
      if (denial.status === 507) {
        throw new InsufficientStorageError(denial.message, {
          code: denial.code,
          details: denial.detail,
        });
      }
      throw new RateLimitedError(denial.message, {
        code: denial.code,
        details: denial.detail,
      });
    }

    const renderer = browserRenderer(c.env.BROWSER);
    const result = await renderer.screenshot(input);

    await recordUsageSafe(c.env.DB, workspaceName, { bytes: 0, objects: 0, uploads: 1 });

    return new Response(result.png, {
      status: 200,
      headers: { "Content-Type": result.contentType || "image/png" },
    });
  },
);
