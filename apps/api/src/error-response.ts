/**
 * Single boundary serializer for HTTP error responses. Routes and middleware
 * throw `AppError` subclasses (or plain values that `AppError.from` wraps);
 * this turns them into the nested wire envelope.
 */
import { AppError, isAppError } from "@uploads/errors";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export function respondError(c: Context, err: unknown): Response {
  const appErr = isAppError(err) ? err : AppError.from(err);
  if (!appErr.expose || appErr.type === "internal") {
    const cause = appErr.cause;
    console.error(
      JSON.stringify({
        message: appErr.message,
        code: appErr.code,
        type: appErr.type,
        stack: appErr.stack,
        ...(cause instanceof Error
          ? { cause: cause.message, causeStack: cause.stack }
          : cause !== undefined
            ? { cause: String(cause) }
            : {}),
      }),
    );
  }
  applyRetryAfter(c, appErr);
  return c.json(appErr.toWire(), appErr.status as ContentfulStatusCode);
}

/**
 * Retry metadata on a refused request (issue #829 §3).
 *
 * `Retry-After` (RFC 9110, seconds) is the standard header and is emitted
 * whenever the error carries a `retry_after` figure we actually know — from
 * `RateLimitedError`'s `retryAfterSeconds`, which the rate-limit guards set
 * from their configured window. `X-Retry-After` is emitted alongside it for
 * compatibility: Better Auth uses that spelling, the shipped client reads
 * both, and dropping it would break callers pinned to the old header.
 *
 * Errors that carry no figure emit neither header. The `Retry-After: 1` a
 * route sets by hand for an in-progress idempotent replay is a 409, not a
 * rate limit, and is left exactly as that route wrote it.
 *
 * Deliberately absent: `RateLimit-Limit`/`-Remaining`/`-Reset`. A Cloudflare
 * `RateLimit` binding's `limit()` returns `{ success }` and nothing more, so
 * there is no accurate quota or reset instant to report. Inventing one would
 * be worse than omitting it, and a client that trusted a fabricated
 * `Remaining` would back off at the wrong time.
 */
function applyRetryAfter(c: Context, err: AppError): void {
  const details = err.details as { retry_after?: unknown } | undefined;
  const retryAfter = details?.retry_after;
  if (typeof retryAfter !== "number" || !Number.isFinite(retryAfter) || retryAfter <= 0) return;
  const seconds = String(Math.max(1, Math.ceil(retryAfter)));
  // `c.header` merges into the response `c.json` builds below.
  c.header("Retry-After", seconds);
  c.header("X-Retry-After", seconds);
}
