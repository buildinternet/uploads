/**
 * Server-Timing headers + slow-op structured logs (issue #812).
 *
 * A small, dependency-free helper any Worker can wrap its D1/service-binding
 * awaits with: it measures wall-clock ms across the `await` (Date.now
 * advances across I/O awaits on Workers — see issue #812), optionally reads
 * a D1 result's `meta.duration` as execution ms, collects entries per
 * request for a standard `Server-Timing` response header, and logs one
 * structured line when an op is slow.
 *
 * Deliberately emits only op names and durations — never query text, ids,
 * tokens, or any other value that could leak into logs or a response header.
 */

/** One measured operation: a name plus wall-clock ms, and execution ms when known (D1's `meta.duration`). */
export interface TimingEntry {
  name: string;
  wallMs: number;
  execMs?: number;
}

export type SlowOpOutcome = "ok" | "error";

/** Structured shape logged for an operation that exceeds the slow-op threshold. */
export interface SlowOpEvent {
  route?: string;
  op: string;
  wallMs: number;
  execMs?: number;
  outcome: SlowOpOutcome;
}

/** Env var names read by {@link slowOpThresholdMs} / {@link serverTimingDisabled}. Both optional. */
export interface TimingEnv {
  /** Slow-op log threshold in ms. Defaults to {@link DEFAULT_SLOW_OP_THRESHOLD_MS} when unset/invalid. */
  SLOW_OP_THRESHOLD_MS?: string;
  /** Kill switch for `Server-Timing` header emission — logging is unaffected. "1" or "true" disables. */
  SERVER_TIMING_DISABLED?: string;
}

export const DEFAULT_SLOW_OP_THRESHOLD_MS = 1000;

function truthyFlag(value: string | undefined): boolean {
  return value === "1" || (value?.toLowerCase() ?? "") === "true";
}

/**
 * Reads `SLOW_OP_THRESHOLD_MS` from env (Worker env vars are always
 * strings); falls back to the default on unset/negative/NaN. `0` is a valid
 * override (logs every op) — only a negative or non-numeric value is
 * treated as misconfigured.
 */
export function slowOpThresholdMs(env: TimingEnv | undefined): number {
  const raw = Number(env?.SLOW_OP_THRESHOLD_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_SLOW_OP_THRESHOLD_MS;
}

/** Reads the `SERVER_TIMING_DISABLED` kill switch — silences header emission only, never the slow-op log. */
export function serverTimingDisabled(env: TimingEnv | undefined): boolean {
  return truthyFlag(env?.SERVER_TIMING_DISABLED);
}

// Server-Timing metric names are tokens (RFC 9110 token grammar); strip
// anything else rather than risk a malformed header from an unexpected op name.
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function formatDur(ms: number): string {
  return (ms < 10 ? ms.toFixed(3) : ms.toFixed(1)).replace(/\.?0+$/, "") || "0";
}

/**
 * Collects {@link TimingEntry} values across one request and renders them as
 * a `Server-Timing` header value, e.g.
 * `d1;dur=4012, d1exec;dur=0.4, auth;dur=3998`.
 */
export class ServerTiming {
  private readonly entries: TimingEntry[] = [];

  record(entry: TimingEntry): void {
    this.entries.push(entry);
  }

  isEmpty(): boolean {
    return this.entries.length === 0;
  }

  /** Renders the collected entries, or `null` when there is nothing to report. */
  header(): string | null {
    if (this.entries.length === 0) return null;
    const parts: string[] = [];
    for (const entry of this.entries) {
      const name = sanitizeName(entry.name);
      parts.push(`${name};dur=${formatDur(entry.wallMs)}`);
      if (entry.execMs !== undefined) {
        parts.push(`${name}exec;dur=${formatDur(entry.execMs)}`);
      }
    }
    return parts.join(", ");
  }

  /**
   * Returns `response` with a `Server-Timing` header set, unless `disabled`
   * is true or there is nothing to report — in which case `response` is
   * returned unchanged (same instance, no header set).
   */
  applyTo(response: Response, opts?: { disabled?: boolean }): Response {
    const value = opts?.disabled ? null : this.header();
    if (value === null) return response;
    const headers = new Headers(response.headers);
    headers.set("Server-Timing", value);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

/** Extracts D1's execution-duration meta from a `.run()`/`.all()` result, when present. `.first()` results carry no `meta`. */
export function d1ExecMs(
  result: { meta?: { duration?: number } } | null | undefined,
): number | undefined {
  return typeof result?.meta?.duration === "number" ? result.meta.duration : undefined;
}

function logSlowOp(event: SlowOpEvent, thresholdMs: number): void {
  if (event.wallMs < thresholdMs) return;
  // One structured line, values only — no query text, ids, or tokens.
  console.log(
    JSON.stringify({
      msg: "slow_op",
      route: event.route ?? null,
      op: event.op,
      wallMs: Math.round(event.wallMs),
      execMs: event.execMs !== undefined ? Math.round(event.execMs * 100) / 100 : null,
      outcome: event.outcome,
    }),
  );
}

export interface TimeOpOptions<T> {
  /** Op name, e.g. `"d1"`, `"auth"`. Rendered verbatim into the Server-Timing header (sanitized) and the slow-op log. */
  name: string;
  /** Collector to record this entry into. Omit to only get slow-op logging (e.g. a fire-and-forget call with no response to attach a header to). */
  timing?: ServerTiming;
  /** Request path/route, carried into the slow-op log only. */
  route?: string;
  /** Slow-op log threshold in ms. Defaults to {@link DEFAULT_SLOW_OP_THRESHOLD_MS}. */
  thresholdMs?: number;
  /** Extracts execution ms from the resolved value, e.g. {@link d1ExecMs}. */
  execMs?: (result: T) => number | undefined;
}

/**
 * Wraps an awaited operation: measures wall-clock ms across the await,
 * records a {@link TimingEntry} (with exec ms when `execMs` yields one), and
 * logs a structured line when the op is slow. Rethrows on failure after
 * recording/logging it as an `"error"` outcome (with wall ms but no exec ms,
 * since a rejected promise carries no result to extract it from).
 */
export async function timeOp<T>(fn: () => Promise<T>, opts: TimeOpOptions<T>): Promise<T> {
  const thresholdMs = opts.thresholdMs ?? DEFAULT_SLOW_OP_THRESHOLD_MS;
  const start = Date.now();
  try {
    const result = await fn();
    const wallMs = Date.now() - start;
    const execMs = opts.execMs?.(result);
    opts.timing?.record({ name: opts.name, wallMs, execMs });
    logSlowOp({ route: opts.route, op: opts.name, wallMs, execMs, outcome: "ok" }, thresholdMs);
    return result;
  } catch (err) {
    const wallMs = Date.now() - start;
    opts.timing?.record({ name: opts.name, wallMs });
    logSlowOp({ route: opts.route, op: opts.name, wallMs, outcome: "error" }, thresholdMs);
    throw err;
  }
}
