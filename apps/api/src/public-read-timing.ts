import {
  ServerTiming,
  serverTimingDisabled,
  slowOpThresholdMs,
  timeOp,
} from "@uploads/observability";
import type { Context } from "hono";
import type { WorkspaceVars } from "./workspace";

/** Explicit request-local instrumentation; owner callers can omit it. */
export type PublicReadMeasure = <T>(name: string, work: () => Promise<T>) => Promise<T>;
export const unmeasured: PublicReadMeasure = (_name, work) => work();

export async function withPublicReadTiming(
  c: Context<WorkspaceVars>,
  route: string,
  total: string,
  work: (measure: PublicReadMeasure) => Promise<Response>,
): Promise<Response> {
  const timing = new ServerTiming();
  const started = Date.now();
  const measure: PublicReadMeasure = (name, operation) =>
    timeOp(operation, {
      name,
      timing,
      route,
      thresholdMs: slowOpThresholdMs(c.env),
    });
  try {
    c.res = await work(measure);
  } finally {
    timing.record({ name: total, wallMs: Date.now() - started });
    if (!serverTimingDisabled(c.env)) {
      const header = timing.header();
      if (header) c.header("Server-Timing", header, { append: true });
    }
  }
  return c.res;
}
