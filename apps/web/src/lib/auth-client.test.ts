import { afterEach, describe, expect, it, vi } from "vitest";
import { getSession, startLocalDemoSession } from "./auth-client";
import { BROWSER_REQUEST_TIMEOUT_MS, fetchWithTimeout } from "./request";

const timeoutFetch: typeof fetch = async (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener(
      "abort",
      () => reject(new DOMException("request timed out", "AbortError")),
      { once: true },
    );
  });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("fetchWithTimeout", () => {
  it("returns an explicit timeout outcome when the browser request does not settle", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", timeoutFetch);

    const request = fetchWithTimeout("http://127.0.0.1:8788/api/auth/get-session");
    await vi.advanceTimersByTimeAsync(BROWSER_REQUEST_TIMEOUT_MS);
    await expect(request).resolves.toEqual({ kind: "unavailable", reason: "timeout" });
  });
});

describe("getSession", () => {
  it("keeps a valid no-session response distinct from an auth outage", async () => {
    const fetcher = vi.fn(async () => Response.json(null));
    vi.stubGlobal("fetch", fetcher);

    await expect(getSession("http://127.0.0.1:8788")).resolves.toEqual({ kind: "signed_out" });
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:8788/api/auth/get-session",
      expect.objectContaining({ cache: "no-store", credentials: "include" }),
    );
  });

  it("reports service failures and network errors as unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    await expect(getSession("http://127.0.0.1:8788")).resolves.toEqual({
      kind: "unavailable",
      reason: "server",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("network down"))),
    );
    await expect(getSession("http://127.0.0.1:8788")).resolves.toEqual({
      kind: "unavailable",
      reason: "network",
    });
  });
});

describe("startLocalDemoSession", () => {
  it("uses the gated loopback endpoint only for the exact local stack", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetcher);

    await expect(
      startLocalDemoSession("http://127.0.0.1:8788", "http://127.0.0.1:4321"),
    ).resolves.toEqual({ kind: "started" });
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:8788/api/auth/dev-session",
      expect.objectContaining({
        credentials: "include",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );

    await expect(
      startLocalDemoSession("http://localhost:8788", "http://127.0.0.1:4321"),
    ).resolves.toEqual({ kind: "not_enabled" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("retains a demo-session service failure as unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );

    await expect(
      startLocalDemoSession("http://127.0.0.1:8788", "http://127.0.0.1:4321"),
    ).resolves.toEqual({ kind: "unavailable", reason: "server" });
  });
});
