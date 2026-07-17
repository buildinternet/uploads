/**
 * Remote screenshot backend — POSTs to the workspace-authed render endpoint
 * and gets raw PNG bytes back. No local browser required. Network-only; safe
 * to import statically anywhere (no native/optional deps).
 */
import { parseErrorEnvelope } from "./client.js";
import { UploadsError } from "./errors.js";

const POST_TIMEOUT_MS = 30_000;
/** Matches the brief's remote-backend cap for inline HTML bodies. */
export const MAX_REMOTE_HTML_BYTES = 2 * 1024 * 1024;

export interface RemoteRenderRequest {
  url?: string;
  html?: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  selector?: string;
  fullPage?: boolean;
  colorScheme?: "dark" | "light";
  waitUntil?: "load" | "domcontentloaded" | "networkidle" | number;
  /** CSS selectors hidden (display:none) server-side before capture. */
  hide?: string[];
  /**
   * Best-effort reduced-motion on the remote backend: the render endpoint has
   * no true media-feature emulation, so it neutralizes animations/transitions
   * with an injected stylesheet (documented gap, like colorScheme).
   */
  reducedMotion?: boolean;
}

export interface RemoteRenderOptions {
  apiUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Maps the render endpoint's error codes onto CLI error codes. Mirrors
 * client.ts's mapApiError conventions: `render_failed` -> RENDER_FAILED;
 * render-budget denials arrive as the EXISTING `upload_budget_exceeded` code
 * (renders draw from the monthly upload budget — no separate RENDER_BUDGET
 * code), so they fall into the shared UPLOAD_BUDGET mapping/hints. The
 * server's burst limiter reports `rate_limited` explicitly; a bare 429 with
 * no body code is also treated as a throttle (more likely than a budget
 * denial), both mapping to RATE_LIMITED — checked before the generic 429
 * fallback so an explicit `upload_budget_exceeded` on a 429 still wins.
 */
function mapRenderError(status: number, message: string, code?: string): UploadsError {
  if (status === 401 || code === "unauthorized")
    return new UploadsError(message, "UNAUTHORIZED", status);
  if (code === "upload_budget_exceeded") return new UploadsError(message, "UPLOAD_BUDGET", status);
  if (code === "render_failed") return new UploadsError(message, "RENDER_FAILED", status);
  if (code === "rate_limited") return new UploadsError(message, "RATE_LIMITED", status);
  if (status === 429) return new UploadsError(message, "RATE_LIMITED", status);
  return new UploadsError(message, "API_ERROR", status);
}

/** POST the render request; resolves with raw PNG bytes on 200. */
export async function captureRemote(
  body: RemoteRenderRequest,
  opts: RemoteRenderOptions,
): Promise<Uint8Array> {
  if (body.html !== undefined) {
    const htmlBytes = new TextEncoder().encode(body.html).byteLength;
    if (htmlBytes > MAX_REMOTE_HTML_BYTES) {
      throw new UploadsError(
        `html body exceeds the remote backend's ${MAX_REMOTE_HTML_BYTES} byte limit (use --via local instead)`,
        "USAGE",
      );
    }
  }

  const base = opts.apiUrl.replace(/\/$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? POST_TIMEOUT_MS);
  // The body reads stay inside the abort-guarded scope: the timer must cover
  // the full response (a server stalling mid-stream would otherwise hang
  // res.arrayBuffer() forever once the headers had arrived).
  try {
    const res = await fetchImpl(`${base}/v1/render`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const { message, code } = await parseErrorEnvelope(res, "render failed");
      throw mapRenderError(res.status, message, code);
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0) {
      throw new UploadsError("render endpoint returned an empty response", "RENDER_FAILED");
    }
    return bytes;
  } catch (err) {
    if (err instanceof UploadsError) throw err;
    const message = err instanceof Error ? err.message : "network request failed";
    throw new UploadsError(
      message.includes("abort") ? "render request timed out" : message,
      "NETWORK",
    );
  } finally {
    clearTimeout(timer);
  }
}
