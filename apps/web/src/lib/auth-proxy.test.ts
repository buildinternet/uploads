import { afterEach, describe, expect, it, vi } from "vitest";
import {
  proxyAuthRequest,
  serverAuthFetch,
  serverAuthFetchImpl,
  serverGetSession,
} from "./auth-proxy";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Minimal binding fake — records the forwarded request and returns a canned response. */
function fakeAuthBinding(response: Response) {
  const fetch = vi.fn(async (_req: Request) => response);
  return { AUTH: { fetch }, fetchMock: fetch };
}

describe("proxyAuthRequest — binding transport", () => {
  it("forwards the request over env.AUTH with redirect: manual", async () => {
    const { AUTH, fetchMock } = fakeAuthBinding(Response.json({ ok: true }));
    const request = new Request("https://uploads.sh/api/auth/get-session", {
      headers: { cookie: "better-auth.session_token=abc" },
    });

    await proxyAuthRequest({ AUTH }, request);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const forwarded = fetchMock.mock.calls[0]?.[0] as Request;
    expect(forwarded.url).toBe("https://uploads.sh/api/auth/get-session");
    expect(forwarded.redirect).toBe("manual");
    expect(forwarded.headers.get("cookie")).toBe("better-auth.session_token=abc");
  });

  it("passes a 302 + Location through unmodified", async () => {
    const upstream = new Response(null, {
      status: 302,
      headers: { location: "https://uploads.sh/login" },
    });
    const { AUTH } = fakeAuthBinding(upstream);
    const request = new Request("https://uploads.sh/api/auth/sign-in/social");

    const response = await proxyAuthRequest({ AUTH }, request);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://uploads.sh/login");
  });
});

describe("proxyAuthRequest — HTTP fallback transport", () => {
  it("rewrites only the origin, keeping path/query/method/headers/body", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const req = input as Request;
      expect(req.url).toBe("http://127.0.0.1:8788/api/auth/sign-in/magic-link?x=1");
      expect(req.method).toBe("POST");
      expect(req.redirect).toBe("manual");
      expect(req.headers.get("content-type")).toBe("application/json");
      expect(await req.text()).toBe('{"email":"a@b.com"}');
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = new Request("https://uploads.sh/api/auth/sign-in/magic-link?x=1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"email":"a@b.com"}',
    });

    await proxyAuthRequest({}, request);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("defaults to http://127.0.0.1:8788 when UPLOADS_AUTH_ORIGIN is unset", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect((input as Request).url).toMatch(/^http:\/\/127\.0\.0\.1:8788\//);
      return Response.json(null);
    });
    vi.stubGlobal("fetch", fetchMock);

    await proxyAuthRequest({}, new Request("https://uploads.sh/api/auth/get-session"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses UPLOADS_AUTH_ORIGIN when provided", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect((input as Request).url).toBe("https://auth.uploads.localhost/api/auth/get-session");
      return Response.json(null);
    });
    vi.stubGlobal("fetch", fetchMock);

    await proxyAuthRequest(
      { UPLOADS_AUTH_ORIGIN: "https://auth.uploads.localhost" },
      new Request("https://uploads.localhost/api/auth/get-session"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("proxyAuthRequest — legacy cookie clearing", () => {
  it("appends the clearing Set-Cookie when host-only session cookie is set on uploads.sh", async () => {
    const upstream = new Response(null, {
      status: 200,
      headers: {
        "set-cookie":
          "__Secure-better-auth.session_token=xyz; Path=/; Secure; HttpOnly; SameSite=Lax",
      },
    });
    const { AUTH } = fakeAuthBinding(upstream);
    const request = new Request("https://uploads.sh/api/auth/sign-in/magic-link", {
      method: "POST",
    });

    const response = await proxyAuthRequest({ AUTH }, request);
    const setCookies = response.headers.getSetCookie();

    expect(setCookies).toContain(
      "__Secure-better-auth.session_token=; Path=/; Domain=.uploads.sh; Max-Age=0; Secure; HttpOnly; SameSite=Lax",
    );
    expect(setCookies).toHaveLength(2);
  });

  it("does NOT append when the Set-Cookie has a Domain attribute", async () => {
    const upstream = new Response(null, {
      status: 200,
      headers: {
        "set-cookie":
          "__Secure-better-auth.session_token=xyz; Path=/; Domain=.uploads.sh; Secure; HttpOnly; SameSite=Lax",
      },
    });
    const { AUTH } = fakeAuthBinding(upstream);
    const request = new Request("https://uploads.sh/api/auth/sign-in/magic-link", {
      method: "POST",
    });

    const response = await proxyAuthRequest({ AUTH }, request);
    expect(response.headers.getSetCookie()).toHaveLength(1);
  });

  it("does NOT append for a non-session Set-Cookie", async () => {
    const upstream = new Response(null, {
      status: 200,
      headers: { "set-cookie": "some_other_cookie=1; Path=/" },
    });
    const { AUTH } = fakeAuthBinding(upstream);
    const request = new Request("https://uploads.sh/api/auth/sign-in/magic-link", {
      method: "POST",
    });

    const response = await proxyAuthRequest({ AUTH }, request);
    expect(response.headers.getSetCookie()).toHaveLength(1);
  });

  it("does NOT append when the request host is uploads.localhost", async () => {
    const upstream = new Response(null, {
      status: 200,
      headers: {
        "set-cookie":
          "__Secure-better-auth.session_token=xyz; Path=/; Secure; HttpOnly; SameSite=Lax",
      },
    });
    const { AUTH } = fakeAuthBinding(upstream);
    const request = new Request("https://uploads.localhost/api/auth/sign-in/magic-link", {
      method: "POST",
    });

    const response = await proxyAuthRequest({ AUTH }, request);
    expect(response.headers.getSetCookie()).toHaveLength(1);
  });

  it("does NOT append when there is no Set-Cookie at all", async () => {
    const upstream = new Response(null, { status: 200 });
    const { AUTH } = fakeAuthBinding(upstream);
    const request = new Request("https://uploads.sh/api/auth/get-session");

    const response = await proxyAuthRequest({ AUTH }, request);
    expect(response.headers.getSetCookie()).toHaveLength(0);
  });
});

describe("serverGetSession", () => {
  it("forwards the incoming cookie header and targets /api/auth/get-session on the request's own origin", async () => {
    const { AUTH, fetchMock } = fakeAuthBinding(Response.json(null));
    const request = new Request("https://uploads.sh/account/profile", {
      headers: { cookie: "better-auth.session_token=abc" },
    });

    await serverGetSession({ AUTH }, request);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const forwarded = fetchMock.mock.calls[0]?.[0] as Request;
    expect(forwarded.url).toBe("https://uploads.sh/api/auth/get-session");
    expect(forwarded.headers.get("cookie")).toBe("better-auth.session_token=abc");
  });

  it("sends an empty cookie header when the incoming request has none", async () => {
    const { AUTH, fetchMock } = fakeAuthBinding(Response.json(null));
    const request = new Request("https://uploads.sh/account/profile");

    await serverGetSession({ AUTH }, request);

    const forwarded = fetchMock.mock.calls[0]?.[0] as Request;
    expect(forwarded.headers.get("cookie")).toBe("");
  });
});

describe("serverAuthFetch", () => {
  it("resolves a relative path against the request's own origin and forwards its cookie header", async () => {
    const { AUTH, fetchMock } = fakeAuthBinding(Response.json(null));
    const request = new Request("https://uploads.sh/account/profile", {
      headers: { cookie: "better-auth.session_token=abc" },
    });

    await serverAuthFetch({ AUTH }, request, "/api/auth/list-sessions");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const forwarded = fetchMock.mock.calls[0]?.[0] as Request;
    expect(forwarded.url).toBe("https://uploads.sh/api/auth/list-sessions");
    expect(forwarded.headers.get("cookie")).toBe("better-auth.session_token=abc");
  });

  it("sends an empty cookie header when the incoming request has none", async () => {
    const { AUTH, fetchMock } = fakeAuthBinding(Response.json(null));
    const request = new Request("https://uploads.sh/account/profile");

    await serverAuthFetch({ AUTH }, request, "/api/auth/list-accounts");

    const forwarded = fetchMock.mock.calls[0]?.[0] as Request;
    expect(forwarded.headers.get("cookie")).toBe("");
  });

  it("does not overwrite a cookie header the caller's init already set", async () => {
    const { AUTH, fetchMock } = fakeAuthBinding(Response.json(null));
    const request = new Request("https://uploads.sh/account/profile", {
      headers: { cookie: "better-auth.session_token=from-request" },
    });

    await serverAuthFetch({ AUTH }, request, "/api/auth/get-session", {
      headers: { cookie: "better-auth.session_token=from-caller" },
    });

    const forwarded = fetchMock.mock.calls[0]?.[0] as Request;
    expect(forwarded.headers.get("cookie")).toBe("better-auth.session_token=from-caller");
  });

  it("passes method/init through", async () => {
    const { AUTH, fetchMock } = fakeAuthBinding(Response.json({ ok: true }));
    const request = new Request("https://uploads.sh/account/profile");

    await serverAuthFetch({ AUTH }, request, "/api/auth/sign-out", { method: "POST" });

    const forwarded = fetchMock.mock.calls[0]?.[0] as Request;
    expect(forwarded.method).toBe("POST");
    expect(forwarded.url).toBe("https://uploads.sh/api/auth/sign-out");
  });
});

describe("serverAuthFetchImpl", () => {
  it("adapts serverAuthFetch to a fetch(input, init) shape for auth-client's fetchImpl", async () => {
    const { AUTH, fetchMock } = fakeAuthBinding(Response.json({ user: { id: "1" } }));
    const request = new Request("https://uploads.sh/account/profile", {
      headers: { cookie: "better-auth.session_token=abc" },
    });

    const fetchImpl = serverAuthFetchImpl({ AUTH }, request);
    const response = await fetchImpl("/api/auth/get-session", { cache: "no-store" });

    expect(await response.json()).toEqual({ user: { id: "1" } });
    const forwarded = fetchMock.mock.calls[0]?.[0] as Request;
    expect(forwarded.url).toBe("https://uploads.sh/api/auth/get-session");
    expect(forwarded.headers.get("cookie")).toBe("better-auth.session_token=abc");
  });
});
