import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import { nameActiveSpan } from "@uploads/observability/tracing";

/**
 * Names the invocation's root span after the matched route pattern
 * (`GET /v1/workspaces/:workspace/files`), so traces group by endpoint and
 * never carry a workspace slug or file key in the span name.
 */
export const traceRoute: MiddlewareHandler = async (c, next) => {
  nameActiveSpan(`${c.req.method} ${routePath(c, -1)}`);
  await next();
};
