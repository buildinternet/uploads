import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadProfilePageData,
  renderSessionsHtml,
  renderSignInMethodsHtml,
} from "./account-profile-ui";
import type { AuthSession, LinkedAccount, ProviderAccountInfo } from "./auth-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("renderSignInMethodsHtml", () => {
  it("renders a magic-link fallback row plus a not-connected GitHub Connect row when nothing is linked", () => {
    const html = renderSignInMethodsHtml([], null);
    expect(html).toMatch(/Magic link sign-in/);
    expect(html).toMatch(/data-connect-github/);
    expect(html).toMatch(/Not connected/);
  });

  it("renders the live GitHub profile detail and omits the Connect row when GitHub is linked", () => {
    const accounts: LinkedAccount[] = [
      { id: "a1", providerId: "github", accountId: "12345", scopes: ["read:user"] },
    ];
    const githubInfo: ProviderAccountInfo = {
      user: { email: "z@example.com" },
      data: { login: "zachdunn" },
    };
    const html = renderSignInMethodsHtml(accounts, githubInfo);
    expect(html).toMatch(/@zachdunn/);
    expect(html).toMatch(/z@example\.com/);
    expect(html).toMatch(/id 12345/);
    expect(html).toMatch(/scopes read:user/);
    expect(html).not.toMatch(/data-connect-github/);
    expect(html).toMatch(/ul-badge--ok">Connected/);
  });

  it("renders a non-github provider row and still appends the not-connected GitHub row", () => {
    const accounts: LinkedAccount[] = [
      { id: "a2", providerId: "google", accountId: "1", createdAt: "2026-01-01T00:00:00.000Z" },
    ];
    const html = renderSignInMethodsHtml(accounts, null);
    expect(html).toMatch(/google/);
    expect(html).toMatch(/Linked/);
    expect(html).toMatch(/data-connect-github/);
  });
});

describe("renderSessionsHtml", () => {
  const base: AuthSession = {
    id: "s1",
    token: "tok-1",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-09-01T00:00:00.000Z",
  };

  it("returns an empty string for the empty-sessions edge case", () => {
    expect(renderSessionsHtml([], null)).toBe("");
  });

  it("orders the current session first regardless of updatedAt and badges/labels it", () => {
    const older: AuthSession = { ...base, id: "s1", token: "tok-1" };
    const newer: AuthSession = {
      ...base,
      id: "s2",
      token: "tok-2",
      updatedAt: "2026-08-10T00:00:00.000Z",
    };
    const html = renderSessionsHtml([older, newer], "tok-1");
    expect(html.indexOf("This device")).toBeLessThan(html.indexOf('data-revoke="tok-2"'));
    expect(html).toMatch(/ul-badge--accent">This device/);
    expect(html).toMatch(/detail-current">Current/);
  });

  it("badges a CLI session and offers a revoke button for non-current sessions", () => {
    const cli: AuthSession = {
      ...base,
      id: "s3",
      token: "tok-3",
      userAgent: "@buildinternet/uploads/1.2.3 (device-token)",
    };
    const html = renderSessionsHtml([cli], "some-other-token");
    expect(html).toMatch(/uploads CLI 1\.2\.3/);
    expect(html).toMatch(/ul-badge">CLI/);
    expect(html).toMatch(/data-revoke="tok-3"/);
  });
});

describe("loadProfilePageData", () => {
  it("returns all-null fields when there is no cookie", async () => {
    await expect(loadProfilePageData("https://auth.uploads.sh", "")).resolves.toEqual({
      user: null,
      currentToken: null,
      accounts: null,
      githubInfo: null,
      sessions: null,
    });
    await expect(loadProfilePageData("https://auth.uploads.sh", "   ")).resolves.toEqual({
      user: null,
      currentToken: null,
      accounts: null,
      githubInfo: null,
      sessions: null,
    });
  });

  it("fetches session/accounts/sessions with the forwarded cookie and resolves github info sequentially", async () => {
    const user = { id: "u1", email: "z@example.com", name: "Zach", role: "member" };
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("get-session")) {
        return Response.json({ user, session: { token: "tok-1" } });
      }
      if (url.includes("list-accounts")) {
        return Response.json([{ id: "a1", providerId: "github", accountId: "42" }]);
      }
      if (url.includes("list-sessions")) {
        return Response.json([
          { id: "s1", token: "tok-1", createdAt: "x", updatedAt: "x", expiresAt: "x" },
        ]);
      }
      if (url.includes("account-info")) {
        return Response.json({ user: { email: "z@example.com" }, data: { login: "zachdunn" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);

    const data = await loadProfilePageData(
      "https://auth.uploads.sh",
      "better-auth.session_token=abc",
    );
    expect(data.user).toEqual(user);
    expect(data.currentToken).toBe("tok-1");
    expect(data.accounts).toEqual([{ id: "a1", providerId: "github", accountId: "42" }]);
    expect(data.sessions).toEqual([
      { id: "s1", token: "tok-1", createdAt: "x", updatedAt: "x", expiresAt: "x" },
    ]);
    expect(data.githubInfo).toEqual({
      user: { email: "z@example.com" },
      data: { login: "zachdunn" },
    });

    // Every request forwarded the cookie header (server-side fetch, no cookie jar).
    for (const call of fetcher.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      expect(init?.headers).toEqual({ cookie: "better-auth.session_token=abc" });
    }
  });

  it("skips the account-info lookup when no github account is linked", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("get-session")) return Response.json(null);
      if (url.includes("list-accounts")) return Response.json([]);
      if (url.includes("list-sessions")) return Response.json([]);
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);

    const data = await loadProfilePageData("https://auth.uploads.sh", "cookie=1");
    expect(data.user).toBeNull();
    expect(data.githubInfo).toBeNull();
    expect(fetcher.mock.calls.some((call) => String(call[0]).includes("account-info"))).toBe(false);
  });

  it("leaves fields null when the underlying fetches fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    const data = await loadProfilePageData("https://auth.uploads.sh", "cookie=1");
    expect(data).toEqual({
      user: null,
      currentToken: null,
      accounts: null,
      githubInfo: null,
      sessions: null,
    });
  });
});
