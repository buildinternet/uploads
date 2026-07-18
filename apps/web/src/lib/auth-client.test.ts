import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAccountInfo,
  getOAuthPublicClient,
  getSession,
  linkGitHub,
  listAccounts,
  listSessions,
  revokeSession,
  sendMagicLink,
  getOAuthWorkspaceChoice,
  repairOAuthQuery,
  setOAuthWorkspaceChoice,
  startLocalDemoSession,
  submitOAuthConsent,
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

describe("linkGitHub", () => {
  it("posts link-social and navigates to the authorize URL", async () => {
    const hrefSetter = vi.fn();
    vi.stubGlobal("location", {
      get href() {
        return "https://uploads.sh/account/profile";
      },
      set href(value: string) {
        hrefSetter(value);
      },
    });
    const fetcher = vi.fn(async () =>
      Response.json({ url: "https://github.com/login/oauth/authorize?x=1" }),
    );
    vi.stubGlobal("fetch", fetcher);

    await expect(
      linkGitHub("https://auth.uploads.sh", "https://uploads.sh/account/profile"),
    ).resolves.toBe(true);

    expect(fetcher).toHaveBeenCalledWith(
      "https://auth.uploads.sh/api/auth/link-social",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({
          provider: "github",
          callbackURL: "https://uploads.sh/account/profile",
          errorCallbackURL: "https://uploads.sh/account/profile",
        }),
      }),
    );
    expect(hrefSetter).toHaveBeenCalledWith("https://github.com/login/oauth/authorize?x=1");
  });

  it("returns false when the auth worker rejects or omits a URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    await expect(
      linkGitHub("https://auth.uploads.sh", "https://uploads.sh/account/profile"),
    ).resolves.toBe(false);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({})),
    );
    await expect(
      linkGitHub("https://auth.uploads.sh", "https://uploads.sh/account/profile"),
    ).resolves.toBe(false);
  });
});

function stubLocation(search: string) {
  vi.stubGlobal("location", { search });
}

describe("sendMagicLink oauth resume", () => {
  it("injects oauth_query when location.search carries a signed sig= param", async () => {
    stubLocation("?client_id=abc&sig=deadbeef");
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetcher);

    await sendMagicLink("https://auth.uploads.sh", "a@example.com", "https://uploads.sh/account");

    expect(fetcher).toHaveBeenCalledWith(
      "https://auth.uploads.sh/api/auth/sign-in/magic-link",
      expect.objectContaining({
        body: JSON.stringify({
          email: "a@example.com",
          callbackURL: "https://uploads.sh/account",
          oauth_query: "client_id=abc&sig=deadbeef",
        }),
      }),
    );
  });

  it("omits oauth_query when there is no signed query", async () => {
    stubLocation("");
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetcher);

    await sendMagicLink("https://auth.uploads.sh", "a@example.com", "https://uploads.sh/account");

    expect(fetcher).toHaveBeenCalledWith(
      "https://auth.uploads.sh/api/auth/sign-in/magic-link",
      expect.objectContaining({
        body: JSON.stringify({
          email: "a@example.com",
          callbackURL: "https://uploads.sh/account",
        }),
      }),
    );
  });
});

describe("getOAuthPublicClient", () => {
  it("returns the client on success and null on failure or malformed body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ client_id: "c1", client_name: "Agent App" })),
    );
    await expect(getOAuthPublicClient("https://auth.uploads.sh", "c1")).resolves.toEqual({
      client_id: "c1",
      client_name: "Agent App",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    await expect(getOAuthPublicClient("https://auth.uploads.sh", "c1")).resolves.toBeNull();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({})),
    );
    await expect(getOAuthPublicClient("https://auth.uploads.sh", "c1")).resolves.toBeNull();
  });
});

describe("submitOAuthConsent", () => {
  it("returns the redirect on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ redirect_uri: "https://client.example/callback?code=1" })),
    );
    await expect(
      submitOAuthConsent("https://auth.uploads.sh", {
        accept: true,
        scope: "files:read",
        oauthQuery: "client_id=c1&sig=x",
      }),
    ).resolves.toEqual({ ok: true, redirectUri: "https://client.example/callback?code=1" });
  });

  it("returns the redirect from better-auth 1.6.23's `{ redirect, url }` shape (prod-verified)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ redirect: true, url: "https://client.example/callback?code=2" }),
      ),
    );
    await expect(
      submitOAuthConsent("https://auth.uploads.sh", {
        accept: true,
        scope: "files:read",
        oauthQuery: "client_id=c1&sig=x",
      }),
    ).resolves.toEqual({ ok: true, redirectUri: "https://client.example/callback?code=2" });
  });

  it("surfaces the AS error description on rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error_description: "expired request" }, { status: 400 })),
    );
    await expect(
      submitOAuthConsent("https://auth.uploads.sh", { accept: false, oauthQuery: "sig=x" }),
    ).resolves.toEqual({ ok: false, error: "expired request" });
  });
});

describe("repairOAuthQuery", () => {
  it("re-encodes literal + inside the sig param only", () => {
    expect(repairOAuthQuery("?client_id=c1&scope=files%3Aread+files%3Awrite&sig=aB+cD/eF=")).toBe(
      "client_id=c1&scope=files%3Aread+files%3Awrite&sig=aB%2BcD/eF=",
    );
  });

  it("is a no-op for a cleanly encoded signed query", () => {
    const clean = "client_id=c1&state=x-_y&sig=aB%2BcD%2FeF%3D";
    expect(repairOAuthQuery(`?${clean}`)).toBe(clean);
    expect(repairOAuthQuery("?client_id=c1")).toBe("client_id=c1");
    expect(repairOAuthQuery("")).toBe("");
  });
});

describe("getOAuthWorkspaceChoice", () => {
  it("returns the server-resolved slug on 2xx", async () => {
    const fetcher = vi.fn(async () => Response.json({ workspace: "beta" }));
    vi.stubGlobal("fetch", fetcher);

    await expect(getOAuthWorkspaceChoice("https://auth.uploads.sh")).resolves.toBe("beta");
    expect(fetcher).toHaveBeenCalledWith(
      "https://auth.uploads.sh/api/auth/oauth2/workspace-choice",
      expect.objectContaining({ credentials: "include", cache: "no-store" }),
    );
  });

  it("returns null on non-2xx, malformed body, or thrown fetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    await expect(getOAuthWorkspaceChoice("https://auth.uploads.sh")).resolves.toBeNull();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ workspace: 42 })),
    );
    await expect(getOAuthWorkspaceChoice("https://auth.uploads.sh")).resolves.toBeNull();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await expect(getOAuthWorkspaceChoice("https://auth.uploads.sh")).resolves.toBeNull();
  });
});

describe("setOAuthWorkspaceChoice", () => {
  it("posts the chosen workspace slug and returns true only on 2xx", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetcher);

    await expect(setOAuthWorkspaceChoice("https://auth.uploads.sh", "acme")).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledWith(
      "https://auth.uploads.sh/api/auth/oauth2/workspace-choice",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace: "acme" }),
      }),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 403 })),
    );
    await expect(setOAuthWorkspaceChoice("https://auth.uploads.sh", "acme")).resolves.toBe(false);
  });

  it("returns false on a thrown fetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await expect(setOAuthWorkspaceChoice("https://auth.uploads.sh", "acme")).resolves.toBe(false);
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
