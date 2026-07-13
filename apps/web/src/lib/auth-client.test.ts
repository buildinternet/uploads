import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAccountInfo,
  getSession,
  listAccounts,
  listSessions,
  revokeSession,
  startLocalDemoSession,
} from "./auth-client";
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

describe("listSessions / listAccounts", () => {
  it("returns rows on success and null on outage", async () => {
    const rows = [
      {
        id: "s1",
        token: "tok-1",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
        expiresAt: "2026-08-01T00:00:00.000Z",
        userAgent: "@buildinternet/uploads/1.0.0 (device-token)",
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(rows)),
    );
    await expect(listSessions("http://127.0.0.1:8788")).resolves.toEqual(rows);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    await expect(listSessions("http://127.0.0.1:8788")).resolves.toBeNull();
  });

  it("filters malformed rows and loads accounts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("list-sessions")) {
          return Response.json([
            { id: "ok", token: "t", createdAt: "x", updatedAt: "x", expiresAt: "x" },
            { id: "no-token" },
          ]);
        }
        return Response.json([
          {
            id: "a1",
            providerId: "github",
            accountId: "12345",
            scopes: ["read:user", "user:email"],
          },
          { id: "bad" },
        ]);
      }),
    );
    await expect(listSessions("http://127.0.0.1:8788")).resolves.toEqual([
      { id: "ok", token: "t", createdAt: "x", updatedAt: "x", expiresAt: "x" },
    ]);
    await expect(listAccounts("https://auth.uploads.sh")).resolves.toEqual([
      {
        id: "a1",
        providerId: "github",
        accountId: "12345",
        scopes: ["read:user", "user:email"],
      },
    ]);
  });
});

describe("getAccountInfo", () => {
  it("returns null on failure and parses provider profiles", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          user: { id: 1, name: "Zach", email: "z@example.com" },
          data: { login: "zachdunn", id: 1 },
        }),
      ),
    );
    await expect(
      getAccountInfo("https://auth.uploads.sh", {
        providerId: "github",
        accountId: "1",
      }),
    ).resolves.toEqual({
      user: { id: 1, name: "Zach", email: "z@example.com" },
      data: { login: "zachdunn", id: 1 },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 400 })),
    );
    await expect(
      getAccountInfo("https://auth.uploads.sh", {
        providerId: "github",
        accountId: "1",
      }),
    ).resolves.toBeNull();
  });
});

describe("revokeSession", () => {
  it("returns true only on 2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    await expect(revokeSession("http://127.0.0.1:8788", "tok")).resolves.toBe(true);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 403 })),
    );
    await expect(revokeSession("http://127.0.0.1:8788", "tok")).resolves.toBe(false);
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
