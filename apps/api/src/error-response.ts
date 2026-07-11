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
  return c.json(appErr.toWire(), appErr.status as ContentfulStatusCode);
}
