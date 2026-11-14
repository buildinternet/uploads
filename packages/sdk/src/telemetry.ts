/**
 * OpenTelemetry spans for SDK calls, the way Better Auth does it: the SDK
 * never depends on an OpenTelemetry package. When the app has registered a
 * tracer (any OpenTelemetry JS SDK 1.x/2.x), each client call becomes an
 * `uploads.<method>` client span in the app's own traces. With nothing
 * registered, calls run untouched.
 *
 * The tracer comes from `UploadsClientOptions.tracer` when given, otherwise
 * from the global the OpenTelemetry API registers on `globalThis`, so the
 * SDK needs no import that a bundler would have to resolve.
 *
 * Attributes are the workspace slug, the API host, the method, file size and
 * content type for `put`, and an error code on failure. Never the token, a
 * key, metadata values, or file contents.
 */

export type SpanAttributeValue = string | number | boolean;
export type SpanAttributes = Record<string, SpanAttributeValue | undefined>;

/** The parts of an OpenTelemetry `Span` the SDK uses. */
export interface TelemetrySpan {
  setAttributes(attributes: Record<string, SpanAttributeValue>): unknown;
  recordException(exception: unknown): void;
  setStatus(status: { code: number; message?: string }): unknown;
  end(): void;
}

/** The parts of an OpenTelemetry `Tracer` the SDK uses. Any OpenTelemetry tracer fits. */
export interface TelemetryTracer {
  startActiveSpan<T>(
    name: string,
    options: { kind?: number; attributes?: Record<string, SpanAttributeValue> },
    fn: (span: TelemetrySpan) => T,
  ): T;
}

const INSTRUMENTATION_SCOPE = "@buildinternet/uploads-sdk";
/** `SpanKind.CLIENT` and `SpanStatusCode.ERROR` from `@opentelemetry/api`. */
const SPAN_KIND_CLIENT = 2;
const STATUS_ERROR = 2;

/** Where `@opentelemetry/api` 1.x keeps its registered providers. */
const OTEL_GLOBAL = Symbol.for("opentelemetry.js.api.1");

function clean(attributes: SpanAttributes): Record<string, SpanAttributeValue> {
  const out: Record<string, SpanAttributeValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== "") out[key] = value;
  }
  return out;
}

/** The app's registered tracer, or undefined when OpenTelemetry isn't set up. */
export function globalTracer(): TelemetryTracer | undefined {
  try {
    const api = (globalThis as Record<symbol, unknown>)[OTEL_GLOBAL] as
      | { trace?: { getTracer?(name: string): TelemetryTracer } }
      | undefined;
    return api?.trace?.getTracer?.(INSTRUMENTATION_SCOPE);
  } catch {
    return undefined;
  }
}

function errorType(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && typeof err.code === "string") {
    return err.code;
  }
  return err instanceof Error ? err.name : "Error";
}

function sizeOf(body: unknown): number | undefined {
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.size;
  return undefined;
}

/** Extra attributes for calls where a size or type helps read a trace. */
function callAttributes(method: string, args: unknown[]): SpanAttributes {
  if (method === "put") {
    const opts = args[2] as { contentType?: string } | undefined;
    return { "file.size": sizeOf(args[1]), "file.content_type": opts?.contentType };
  }
  if (method === "request") {
    return { "http.request.method": typeof args[0] === "string" ? args[0] : undefined };
  }
  return {};
}

function resultAttributes(method: string, result: unknown): SpanAttributes {
  if (method !== "put" || !result || typeof result !== "object") return {};
  const put = result as { replaced?: boolean; holdCheck?: string };
  return { "uploads.replaced": put.replaced, "uploads.hold_check": put.holdCheck };
}

function quietly(fn: () => void): void {
  try {
    fn();
  } catch {
    // telemetry must never change the outcome
  }
}

/**
 * Wraps every async method of `client` in an `uploads.<method>` span.
 * `tracer` returns the tracer for each call (so one registered after the
 * client was made still counts), or undefined to skip tracing.
 */
export function traceClient<T extends Record<string, unknown>>(
  client: T,
  base: SpanAttributes,
  tracer: () => TelemetryTracer | undefined,
): T {
  const traced: Record<string, unknown> = {};
  for (const [method, value] of Object.entries(client)) {
    if (typeof value !== "function") {
      traced[method] = value;
      continue;
    }
    const fn = value as (...args: unknown[]) => Promise<unknown>;
    traced[method] = (...args: unknown[]) => {
      const t = tracer();
      if (!t) return fn(...args);
      let attributes: Record<string, SpanAttributeValue> = {};
      quietly(() => {
        attributes = clean({ ...base, ...callAttributes(method, args) });
      });
      return t.startActiveSpan(
        `uploads.${method}`,
        { kind: SPAN_KIND_CLIENT, attributes },
        async (span) => {
          try {
            const result = await fn(...args);
            quietly(() => span.setAttributes(clean(resultAttributes(method, result))));
            return result;
          } catch (err) {
            quietly(() => {
              span.setAttributes({ "error.type": errorType(err) });
              span.recordException(err);
              span.setStatus({ code: STATUS_ERROR, message: errorType(err) });
            });
            throw err;
          } finally {
            quietly(() => span.end());
          }
        },
      );
    };
  }
  return traced as T;
}
