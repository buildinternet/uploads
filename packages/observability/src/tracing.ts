/**
 * Custom spans for Workers tracing.
 *
 * Cloudflare traces fetch, D1, R2, KV and service-binding calls on its own.
 * These helpers add our own steps around them (classification, previews,
 * GitHub syncs, holds, MCP tool calls) so a trace reads as uploads work and
 * not as a flat list of queries. Spans nest by async context, so platform
 * spans inside `work` land under the custom span.
 *
 * Tracing is turned on with `observability.traces` in each wrangler.jsonc.
 * Without it, or in a runtime without the tracing API (Node tests), `work`
 * just runs and the attribute calls do nothing.
 *
 * Attributes are names, counts, sizes, content types and outcomes. Never a
 * token, an email, a file key, file contents, or a caption.
 */
import { tracing } from "cloudflare:workers";

export type SpanAttributes = Record<string, string | number | boolean | undefined>;

/** The part of the runtime `Span` these helpers use. */
export interface TraceSpan {
  setAttributes(attributes: SpanAttributes): unknown;
}

interface RuntimeSpan extends TraceSpan {
  recordException?(exception: unknown): void;
  setStatus?(status: { code: "unset" | "ok" | "error"; message?: string }): unknown;
  updateName?(name: string): unknown;
}

interface RuntimeTracing {
  enterSpan?<T>(name: string, callback: (span: RuntimeSpan) => T): T;
  getActiveSpan?(): RuntimeSpan | undefined;
}

const NO_SPAN: TraceSpan = { setAttributes() {} };

function runtime(): RuntimeTracing | undefined {
  try {
    return tracing as unknown as RuntimeTracing | undefined;
  } catch {
    return undefined;
  }
}

function clean(attributes: SpanAttributes): SpanAttributes {
  const out: SpanAttributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === "") continue;
    out[key] = value;
  }
  return out;
}

function markFailed(span: RuntimeSpan, err: unknown): void {
  try {
    span.recordException?.(err instanceof Error ? err : String(err));
    span.setStatus?.({ code: "error", message: err instanceof Error ? err.name : undefined });
  } catch {
    // telemetry must never change the outcome
  }
}

/**
 * Runs `work` inside a span called `name`. A throw is recorded on the span
 * (exception event + error status) and rethrown unchanged.
 */
export function withSpan<T>(
  name: string,
  attributes: SpanAttributes,
  work: (span: TraceSpan) => Promise<T>,
): Promise<T> {
  const api = runtime();
  if (typeof api?.enterSpan !== "function") return work(NO_SPAN);
  return api.enterSpan(name, async (span) => {
    try {
      span.setAttributes(clean(attributes));
    } catch {
      // keep going without attributes
    }
    const safe: TraceSpan = {
      setAttributes(next) {
        try {
          span.setAttributes(clean(next));
        } catch {
          // ignore
        }
      },
    };
    try {
      return await work(safe);
    } catch (err) {
      markFailed(span, err);
      throw err;
    }
  });
}

/** Adds attributes to whichever span is active now (a custom span, or the invocation's root span). */
export function annotateSpan(attributes: SpanAttributes): void {
  try {
    runtime()?.getActiveSpan?.()?.setAttributes(clean(attributes));
  } catch {
    // ignore
  }
}

/**
 * Renames the active span. Called from request middleware, where the active
 * span is the invocation's root, so traces group by route pattern
 * (`GET /v1/workspaces/:workspace/files`) instead of `fetch`.
 */
export function nameActiveSpan(name: string): void {
  try {
    runtime()?.getActiveSpan?.()?.updateName?.(name);
  } catch {
    // ignore
  }
}
