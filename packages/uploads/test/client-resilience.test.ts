import { afterEach, describe, expect, it, vi } from "vitest";
import { createUploadsClient } from "../src/client.js";
import { UploadsError } from "../src/errors.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function client() {
  return createUploadsClient({
    apiUrl: "https://api.test",
    workspace: "test",
    token: "up_test_x",
  });
}

/** A fetch stub that only settles when its AbortSignal fires — simulates a stall. */
function stallingFetch() {
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      }),
  );
}

const listBody = JSON.stringify({ files: [], cursor: null });

describe("request timeouts", () => {
  it("times out a non-retried JSON call and maps to a NETWORK error naming the timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", stallingFetch());

    const promise = client()
      .deleteGallery("gal_1", { expectedVersion: 1 })
      .then(
        () => null,
        (e: unknown) => e,
      );
    await vi.advanceTimersByTimeAsync(15_000);
    const err = await promise;

    expect(err).toBeInstanceOf(UploadsError);
    expect((err as UploadsError).code).toBe("NETWORK");
    expect((err as UploadsError).message).toContain("15000ms");
  });

  it("times out a GET once and retries before ultimately failing", async () => {
    vi.useFakeTimers();
    const fetchMock = stallingFetch();
    vi.stubGlobal("fetch", fetchMock);

    const promise = client()
      .list()
      .then(
        () => null,
        (e: unknown) => e,
      );
    // First attempt times out (15s), backoff (2s default — no response to read
    // X-Retry-After from), then the retried attempt also times out (15s).
    await vi.advanceTimersByTimeAsync(15_000 + 2_000 + 15_000);
    const err = await promise;

    expect(err).toBeInstanceOf(UploadsError);
    expect((err as UploadsError).code).toBe("NETWORK");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("bounded retry", () => {
  it("retries a 503 GET once and succeeds", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls === 1) return new Response(null, { status: 503 });
      return new Response(listBody, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = client().list();
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await promise;

    expect(result.items).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 429 GET once and succeeds", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls === 1) return new Response(null, { status: 429 });
      return new Response(listBody, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = client().list();
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await promise;

    expect(result.items).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after the single retry (max 2 attempts total)", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = client()
      .list()
      .then(
        () => null,
        (e: unknown) => e,
      );
    await vi.advanceTimersByTimeAsync(2_000);
    const err = await promise;

    expect(err).toBeInstanceOf(UploadsError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honors X-Retry-After, capped at ~10s", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return new Response(null, { status: 503, headers: { "X-Retry-After": "100" } });
      }
      return new Response(listBody, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = client().list();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honors a short X-Retry-After under the cap", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return new Response(null, { status: 503, headers: { "X-Retry-After": "1" } });
      }
      return new Response(listBody, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = client().list();
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries gallery creation with the same idempotency key", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls === 1) return new Response(null, { status: 503 });
      return new Response(JSON.stringify({ id: "gal_1", title: "t" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = client().createGallery({ title: "t", idempotencyKey: "create-gallery-1" });
    await vi.advanceTimersByTimeAsync(2_000);
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const requestCalls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const firstHeaders = new Headers(requestCalls[0]?.[1].headers);
    const secondHeaders = new Headers(requestCalls[1]?.[1].headers);
    expect(firstHeaders.get("Idempotency-Key")).toBe("create-gallery-1");
    expect(secondHeaders.get("Idempotency-Key")).toBe("create-gallery-1");
  });

  it("does not retry DELETE on 503", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const err = await client()
      .delete("a.png")
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(UploadsError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("prints a one-line stderr notice when a retry happens", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls === 1) return new Response(null, { status: 503 });
      return new Response(listBody, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const promise = client().list();
    await vi.advanceTimersByTimeAsync(2_000);
    await promise;

    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining("uploads.sh responded 503, retrying in 2s"),
    );
    writeSpy.mockRestore();
  });
});
