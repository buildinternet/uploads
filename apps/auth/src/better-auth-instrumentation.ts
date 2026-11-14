/**
 * Workers build of `@better-auth/core/instrumentation`.
 *
 * Better Auth wraps every endpoint, hook and adapter call in a span
 * (`GET /get-session`, `db findOne session`), but its package export picks a
 * no-op build under the `workerd` condition, so on Workers those spans never
 * exist. wrangler.jsonc aliases the module to this file, which runs the same
 * spans through Workers tracing. They then nest under the request's root
 * span with the automatic D1 spans.
 *
 * Exports must match the real module name for name: the bundler fails the
 * build on a missing one, and better-auth-instrumentation.test.ts compares
 * the two lists. Span names and attributes are Better Auth's own: route
 * templates, operation ids, model names. No user data.
 */
import { tracing } from "cloudflare:workers";

export const ATTR_DB_COLLECTION_NAME = "db.collection.name";
export const ATTR_DB_OPERATION_NAME = "db.operation.name";
export const ATTR_HTTP_RESPONSE_STATUS_CODE = "http.response.status_code";
export const ATTR_HTTP_ROUTE = "http.route";
export const ATTR_OPERATION_ID = "better_auth.operation_id";
export const ATTR_HOOK_TYPE = "better_auth.hook.type";
export const ATTR_CONTEXT = "better_auth.context";

type Attributes = Record<string, string | number | boolean | undefined>;

interface RuntimeSpan {
  setAttributes(attributes: Attributes): unknown;
  recordException?(exception: unknown): void;
  setStatus?(status: { code: "unset" | "ok" | "error"; message?: string }): unknown;
}

export interface SpanRuntime {
  enterSpan?<T>(name: string, callback: (span: RuntimeSpan) => T): T;
}

/** Better Auth throws `ctx.redirect(url)` for flow control: a 3xx APIError is not a failure. */
function redirectStatus(err: unknown): number | undefined {
  if (err == null || typeof err !== "object") return undefined;
  const { name, statusCode } = err as { name?: unknown; statusCode?: unknown };
  if (name !== "APIError" || typeof statusCode !== "number") return undefined;
  return statusCode >= 300 && statusCode < 400 ? statusCode : undefined;
}

function markFailed(span: RuntimeSpan, err: unknown): void {
  try {
    const redirect = redirectStatus(err);
    if (redirect !== undefined) {
      span.setAttributes({ [ATTR_HTTP_RESPONSE_STATUS_CODE]: redirect });
      return;
    }
    span.recordException?.(err instanceof Error ? err : String(err));
    span.setStatus?.({ code: "error", message: err instanceof Error ? err.name : undefined });
  } catch {
    // telemetry must never change the outcome
  }
}

/** Builds `withSpan` over a tracing API. Exported for tests. */
export function spanRunner(runtime: () => SpanRuntime | undefined) {
  return function withSpan<T>(name: string, attributes: Attributes, fn: () => T): T {
    let api: SpanRuntime | undefined;
    try {
      api = runtime();
    } catch {
      api = undefined;
    }
    if (typeof api?.enterSpan !== "function") return fn();
    return api.enterSpan(name, (span) => {
      try {
        span.setAttributes(attributes);
      } catch {
        // keep going without attributes
      }
      try {
        const result = fn();
        if (result instanceof Promise) {
          return result.catch((err: unknown) => {
            markFailed(span, err);
            throw err;
          }) as T;
        }
        return result;
      } catch (err) {
        markFailed(span, err);
        throw err;
      }
    });
  };
}

export const withSpan = spanRunner(() => tracing as unknown as SpanRuntime);

function noopWithSpan<T>(_name: string, _attributes: Attributes, fn: () => T): T {
  return fn();
}

/** Same switch as Better Auth: `experimental.instrumentation.enabled: false` turns spans off. */
export function createWithSpan(options: {
  experimental?: { instrumentation?: { enabled?: boolean } };
}): typeof withSpan {
  return options?.experimental?.instrumentation?.enabled === false ? noopWithSpan : withSpan;
}
