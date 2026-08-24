/**
 * Stall bounds for the api worker's data-plane D1 reads (issue #815, follow-up
 * to the 2026-08-23 D1 stall incident #808). Auth's D1 dependency is already
 * bounded (`AUTH_FETCH_TIMEOUT_MS` in session-auth.ts, `#805`/`#806`); this
 * covers the other side — file listings, by-path/screenshots grouping,
 * search, workspace usage summaries, and galleries. Those reads can't fail
 * open (there is no safe empty-list fallback that isn't misleading), but they
 * can fail *fast*: a stalled read becomes a typed 503 instead of an
 * open-ended hang, so the web app's per-widget error states (already
 * retryable) render in seconds instead of riding out the full stall window.
 *
 * Deliberately NOT applied to writes/mutations (an aborted write still needs
 * to know whether it landed) or to the auth path (already bounded via its own
 * mechanism). Built on top of `timeOp`/`ServerTiming` (`@uploads/observability`,
 * issue #812) so a bounded read still gets the same Server-Timing entry and
 * slow-op log as every other instrumented D1 call, plus one addition: a read
 * that trips the deadline logs with `outcome: "error"` and the response
 * carries `data_unavailable`.
 */
import { ServiceUnavailableError } from "@uploads/errors";
import {
  ServerTiming,
  serverTimingDisabled,
  slowOpThresholdMs,
  timeOp,
  type TimingEnv,
} from "@uploads/observability";
import type { Context } from "hono";

/** Env surface {@link dataReadTimeoutMs} reads. Also extends `TimingEnv` since callers pass the same `env`. */
export interface DataReadEnv extends TimingEnv {
  /**
   * Deadline in ms for one bounded data-plane read. Unset/negative/NaN falls
   * back to {@link DEFAULT_DATA_READ_TIMEOUT_MS}. `"0"` is a valid override
   * that disables the bound entirely (the read runs unbounded, same as
   * before this issue) — for local debugging or an environment that wants
   * the old behavior back without a code change.
   */
  DATA_READ_TIMEOUT_MS?: string;
}

export const DEFAULT_DATA_READ_TIMEOUT_MS = 8000;

/**
 * Resolves the deadline for a bounded read. `0` means "disabled" and is
 * returned as-is; anything else non-finite or negative falls back to the
 * default; unset also falls back to the default.
 */
export function dataReadTimeoutMs(env: DataReadEnv | undefined): number {
  const raw = env?.DATA_READ_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_DATA_READ_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_DATA_READ_TIMEOUT_MS;
  return parsed;
}

/**
 * Races `fn()` against `timeoutMs`. On timeout, throws a typed
 * `ServiceUnavailableError` (`code: "data_unavailable"`) that the api
 * worker's error middleware maps to a 503 — same mapping `session-auth.ts`
 * already relies on for `auth_session_unavailable`.
 *
 * The losing promise is never awaited further, but a `.catch(() => {})` is
 * attached before racing so a `fn()` that eventually rejects after the
 * timeout has already won doesn't surface as an unhandled rejection (same
 * hygiene as `apps/auth/src/rate-limit.ts`'s DO-timeout race).
 */
async function raceWithDeadline<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs === 0) return fn();

  const call = fn();
  call.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new ServiceUnavailableError("data read timed out", {
          code: "data_unavailable",
          details: { timeoutMs },
        }),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([call, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface BoundedReadOptions {
  /** Op name — same role as `TimeOpOptions.name` (Server-Timing entry + slow-op log). */
  name: string;
  /** Collector to record the timing entry into; typically appended to the response afterward. */
  timing?: ServerTiming;
  /** Request path, carried into the slow-op log only. */
  route?: string;
  /** Overrides the resolved env deadline for this call (mainly for tests). */
  timeoutMs?: number;
}

/**
 * Wraps one data-plane D1 read with both the deadline race above and
 * `timeOp` instrumentation. Behaves exactly like `timeOp` on the happy path;
 * a hang past the deadline throws the typed 503 instead of resolving.
 */
export function boundedRead<T>(
  env: DataReadEnv,
  fn: () => Promise<T>,
  opts: BoundedReadOptions,
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? dataReadTimeoutMs(env);
  return timeOp(() => raceWithDeadline(fn, timeoutMs), {
    name: opts.name,
    timing: opts.timing,
    route: opts.route,
    thresholdMs: slowOpThresholdMs(env),
  });
}

/**
 * Route-handler convenience: creates its own `ServerTiming`, runs `fn`
 * through {@link boundedRead}, and appends the resulting header to `c`
 * (merging with anything a prior middleware already appended — same pattern
 * as `workspace.ts`'s private `appendServerTiming`). Use this at a route's
 * top level; use {@link boundedRead} directly when a handler already
 * maintains its own `ServerTiming` across multiple ops.
 */
export async function boundedDataRead<T, E extends { Bindings: Env }>(
  c: Context<E>,
  fn: () => Promise<T>,
  opts: { name: string; timeoutMs?: number },
): Promise<T> {
  const timing = new ServerTiming();
  try {
    return await boundedRead(c.env as DataReadEnv, fn, {
      name: opts.name,
      timing,
      route: c.req.path,
      timeoutMs: opts.timeoutMs,
    });
  } finally {
    if (!serverTimingDisabled(c.env as TimingEnv)) {
      const value = timing.header();
      if (value) c.header("Server-Timing", value, { append: true });
    }
  }
}
