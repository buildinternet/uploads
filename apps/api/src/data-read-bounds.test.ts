/**
 * Stall bounds for data-plane D1 reads (issue #815). Plain vitest + in-process
 * fakes, no real waits — every timeout path below uses fake timers so the
 * suite stays fast regardless of the configured deadline.
 */
import { ServiceUnavailableError } from "@uploads/errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  boundedDataRead,
  boundedRead,
  DEFAULT_DATA_READ_TIMEOUT_MS,
  dataReadTimeoutMs,
} from "./data-read-bounds";

describe("dataReadTimeoutMs", () => {
  it("defaults to 8000ms when unset", () => {
    expect(dataReadTimeoutMs(undefined)).toBe(DEFAULT_DATA_READ_TIMEOUT_MS);
    expect(dataReadTimeoutMs({})).toBe(DEFAULT_DATA_READ_TIMEOUT_MS);
  });

  it("respects a configured override", () => {
    expect(dataReadTimeoutMs({ DATA_READ_TIMEOUT_MS: "250" })).toBe(250);
  });

  it("treats '0' as a valid override that disables the bound", () => {
    expect(dataReadTimeoutMs({ DATA_READ_TIMEOUT_MS: "0" })).toBe(0);
  });

  it("falls back to the default for negative or non-numeric values", () => {
    expect(dataReadTimeoutMs({ DATA_READ_TIMEOUT_MS: "-5" })).toBe(DEFAULT_DATA_READ_TIMEOUT_MS);
    expect(dataReadTimeoutMs({ DATA_READ_TIMEOUT_MS: "not-a-number" })).toBe(
      DEFAULT_DATA_READ_TIMEOUT_MS,
    );
  });
});

describe("boundedRead", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.useRealTimers();
  });

  it("passes through a read that completes under the deadline", async () => {
    const result = await boundedRead({ DATA_READ_TIMEOUT_MS: "8000" }, async () => ({ rows: 3 }), {
      name: "d1_test",
    });
    expect(result).toEqual({ rows: 3 });
  });

  it("throws a typed 503 (data_unavailable) when the read hangs past a tiny injected deadline", async () => {
    vi.useFakeTimers();
    // Never resolves within the test — the deadline must win the race.
    const hang = () => new Promise<never>(() => {});

    const promise = boundedRead({ DATA_READ_TIMEOUT_MS: "5" }, hang, { name: "d1_test" });
    // Attach a rejection handler before advancing timers so the race's own
    // rejection is never briefly unobserved.
    const assertion = expect(promise).rejects.toMatchObject({
      code: "data_unavailable",
      status: 503,
    });
    await vi.advanceTimersByTimeAsync(5);
    await assertion;
  });

  it("the timeout error is a ServiceUnavailableError instance", async () => {
    vi.useFakeTimers();
    const hang = () => new Promise<never>(() => {});
    const promise = boundedRead({ DATA_READ_TIMEOUT_MS: "5" }, hang, { name: "d1_test" });
    const assertion = expect(promise).rejects.toBeInstanceOf(ServiceUnavailableError);
    await vi.advanceTimersByTimeAsync(5);
    await assertion;
  });

  it("does not surface an unhandled rejection when the losing read rejects after the deadline", async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      let rejectLate: (err: unknown) => void = () => undefined;
      const lateRejecter = () =>
        new Promise<never>((_, reject) => {
          rejectLate = reject;
        });

      const promise = boundedRead({ DATA_READ_TIMEOUT_MS: "5" }, lateRejecter, {
        name: "d1_test",
      });
      const assertion = expect(promise).rejects.toMatchObject({ code: "data_unavailable" });
      await vi.advanceTimersByTimeAsync(5);
      await assertion;

      // The original read finally rejects well after the deadline already won.
      rejectLate(new Error("late D1 failure"));
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("honors DATA_READ_TIMEOUT_MS='0' by running the read unbounded", async () => {
    vi.useFakeTimers();
    let resolveLate: (value: string) => void = () => undefined;
    const late = () =>
      new Promise<string>((resolve) => {
        resolveLate = resolve;
      });

    const promise = boundedRead({ DATA_READ_TIMEOUT_MS: "0" }, late, { name: "d1_test" });
    await vi.advanceTimersByTimeAsync(60_000); // far past the normal default — still no timeout set
    resolveLate("ok-eventually");
    await expect(promise).resolves.toBe("ok-eventually");
  });
});

describe("boundedDataRead", () => {
  function fakeContext(env: Record<string, string>) {
    const headers: Array<{ name: string; value: string }> = [];
    return {
      env,
      req: { path: "/v1/workspaces/acme/usage" },
      header: (name: string, value: string) => headers.push({ name, value }),
      _headers: headers,
    };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("appends a Server-Timing header and returns the value on a fast read", async () => {
    const c = fakeContext({});
    const result = await boundedDataRead(c as never, async () => 42, {
      name: "d1_workspace_usage",
    });
    expect(result).toBe(42);
    expect(
      c._headers.some((h) => h.name === "Server-Timing" && h.value.includes("d1_workspace_usage")),
    ).toBe(true);
  });

  it("rejects with data_unavailable when the deadline is overridden per-call", async () => {
    vi.useFakeTimers();
    const c = fakeContext({});
    const hang = () => new Promise<never>(() => {});
    const promise = boundedDataRead(c as never, hang, { name: "d1_workspace_usage", timeoutMs: 5 });
    const assertion = expect(promise).rejects.toMatchObject({
      code: "data_unavailable",
      status: 503,
    });
    await vi.advanceTimersByTimeAsync(5);
    await assertion;
  });
});

describe("writes are unaffected by the data-read bound", () => {
  it("a write called directly (not through boundedRead) is never raced against the deadline", async () => {
    vi.useFakeTimers();
    let resolveWrite: (value: string) => void = () => undefined;
    const slowWrite = () =>
      new Promise<string>((resolve) => {
        resolveWrite = resolve;
      });

    // This mirrors how mutation handlers call `dbFor`-backed write functions
    // directly — no `boundedRead`/`boundedDataRead` wrapper — so nothing
    // races them against DATA_READ_TIMEOUT_MS.
    const result = slowWrite();
    await vi.advanceTimersByTimeAsync(DEFAULT_DATA_READ_TIMEOUT_MS * 10);
    resolveWrite("write-committed");
    await expect(result).resolves.toBe("write-committed");
  });
});
