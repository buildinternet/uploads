import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  d1ExecMs,
  DEFAULT_SLOW_OP_THRESHOLD_MS,
  ServerTiming,
  serverTimingDisabled,
  slowOpThresholdMs,
  timeOp,
} from "./index";

describe("ServerTiming", () => {
  it("renders a header from collected entries, exec ms only when present", () => {
    const timing = new ServerTiming();
    timing.record({ name: "d1", wallMs: 4012, execMs: 0.4 });
    timing.record({ name: "auth", wallMs: 3998 });
    expect(timing.header()).toBe("d1;dur=4012, d1exec;dur=0.4, auth;dur=3998");
  });

  it("returns null when nothing was recorded", () => {
    expect(new ServerTiming().header()).toBeNull();
    expect(new ServerTiming().isEmpty()).toBe(true);
  });

  it("sanitizes op names into bare tokens", () => {
    const timing = new ServerTiming();
    timing.record({ name: "d1 read/write", wallMs: 1 });
    expect(timing.header()).toBe("d1_read_write;dur=1");
  });

  it("applyTo sets the header without mutating the original response", () => {
    const timing = new ServerTiming();
    timing.record({ name: "d1", wallMs: 12.3 });
    const original = new Response("ok", { status: 201 });
    const decorated = timing.applyTo(original);
    expect(decorated).not.toBe(original);
    expect(decorated.status).toBe(201);
    expect(decorated.headers.get("Server-Timing")).toBe("d1;dur=12.3");
    expect(original.headers.get("Server-Timing")).toBeNull();
  });

  it("applyTo returns the same response instance when disabled", () => {
    const timing = new ServerTiming();
    timing.record({ name: "d1", wallMs: 12 });
    const original = new Response("ok");
    const result = timing.applyTo(original, { disabled: true });
    expect(result).toBe(original);
    expect(result.headers.get("Server-Timing")).toBeNull();
  });

  it("applyTo returns the same response instance when there is nothing to report", () => {
    const original = new Response("ok");
    const result = new ServerTiming().applyTo(original);
    expect(result).toBe(original);
  });
});

describe("d1ExecMs", () => {
  it("reads meta.duration off a D1-result-shaped value", () => {
    expect(d1ExecMs({ meta: { duration: 0.42 } })).toBe(0.42);
  });

  it("returns undefined for a result with no meta (e.g. .first())", () => {
    expect(d1ExecMs({})).toBeUndefined();
    expect(d1ExecMs(null)).toBeUndefined();
    expect(d1ExecMs(undefined)).toBeUndefined();
  });
});

describe("timeOp", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("records wall ms and exec ms (from a D1-shaped result) into the collector", async () => {
    const timing = new ServerTiming();
    const result = await timeOp(async () => ({ meta: { duration: 1.5 }, results: [] }), {
      name: "d1",
      timing,
      execMs: d1ExecMs,
    });
    expect(result.results).toEqual([]);
    expect(timing.header()).toMatch(/^d1;dur=\d+(\.\d+)?, d1exec;dur=1\.5$/);
  });

  it("logs a slow-op line when wall ms exceeds the threshold", async () => {
    await timeOp(
      () =>
        new Promise((resolve) => {
          // Force a measurable, real wall-clock delay rather than faking timers,
          // since Date.now() inside timeOp is the thing under test.
          setTimeout(() => resolve("ok"), 5);
        }),
      { name: "auth", route: "/v1/files/x", thresholdMs: 1 },
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(logged).toMatchObject({
      msg: "slow_op",
      op: "auth",
      route: "/v1/files/x",
      outcome: "ok",
    });
    expect(logged.wallMs).toBeGreaterThanOrEqual(1);
  });

  it("does not log below the threshold", async () => {
    await timeOp(async () => "fast", { name: "d1", thresholdMs: 1_000_000 });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("logs an error outcome (with no exec ms) and rethrows on failure", async () => {
    const err = new Error("boom");
    await expect(
      timeOp(
        async () => {
          throw err;
        },
        { name: "d1", thresholdMs: 0 },
      ),
    ).rejects.toThrow(err);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(logged).toMatchObject({ op: "d1", outcome: "error", execMs: null });
  });

  it("uses the default threshold when none is given", async () => {
    await timeOp(async () => "fast", { name: "d1" });
    expect(logSpy).not.toHaveBeenCalled();
    expect(DEFAULT_SLOW_OP_THRESHOLD_MS).toBe(1000);
  });
});

describe("env helpers", () => {
  it("slowOpThresholdMs falls back to the default on unset/invalid values", () => {
    expect(slowOpThresholdMs(undefined)).toBe(DEFAULT_SLOW_OP_THRESHOLD_MS);
    expect(slowOpThresholdMs({})).toBe(DEFAULT_SLOW_OP_THRESHOLD_MS);
    expect(slowOpThresholdMs({ SLOW_OP_THRESHOLD_MS: "not-a-number" })).toBe(
      DEFAULT_SLOW_OP_THRESHOLD_MS,
    );
    expect(slowOpThresholdMs({ SLOW_OP_THRESHOLD_MS: "-5" })).toBe(DEFAULT_SLOW_OP_THRESHOLD_MS);
  });

  it("slowOpThresholdMs reads a valid override", () => {
    expect(slowOpThresholdMs({ SLOW_OP_THRESHOLD_MS: "250" })).toBe(250);
  });

  it("serverTimingDisabled recognizes '1' and 'true' (any case), nothing else", () => {
    expect(serverTimingDisabled(undefined)).toBe(false);
    expect(serverTimingDisabled({})).toBe(false);
    expect(serverTimingDisabled({ SERVER_TIMING_DISABLED: "0" })).toBe(false);
    expect(serverTimingDisabled({ SERVER_TIMING_DISABLED: "1" })).toBe(true);
    expect(serverTimingDisabled({ SERVER_TIMING_DISABLED: "true" })).toBe(true);
    expect(serverTimingDisabled({ SERVER_TIMING_DISABLED: "TRUE" })).toBe(true);
  });
});
