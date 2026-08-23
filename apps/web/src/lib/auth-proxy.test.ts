import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionResultFromResponse } from "./auth-client";
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

/**
 * A binding fake that never resolves on its own — mirrors a D1-stalled auth
 * worker holding the request open indefinitely. Rejects with an AbortError
 * when the forwarded request's own signal aborts, same as a real `fetch`
 * would, so it actually exercises `serverGetSession`'s timeout handling
 * instead of just hanging forever regardless of the signal.
 */
function hangingBinding() {
  return vi.fn(
    (req: Request) =>
      new Promise<Response>((_resolve, reject) => {
        req.signal.addEventListener("abort", () => reject(req.signal.reason), { once: true });
      }),
  );
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

  it("settles with a synthetic 503 (not a throw) when the AUTH binding hangs past the timeout", async () => {
    // Binding fetch never resolves — mirrors a D1-stalled auth worker holding
    // the request open indefinitely. Uses a short injected timeoutMs so the
    // test doesn't actually wait out the real 4s production default.
    const hang = hangingBinding();
    const request = new Request("https://uploads.sh/account/profile", {
      headers: { cookie: "better-auth.session_token=abc" },
    });

    const response = await serverGetSession({ AUTH: { fetch: hang } }, request, 20);

    expect(response.ok).toBe(false);
    expect(response.status).toBe(503);
  });

  it("resolving 503 timeout response parses as unavailable, distinct from a real 401 signed-out response", async () => {
    const { AUTH: signedOutAuth } = fakeAuthBinding(Response.json(null, { status: 401 }));
    const signedOut = await sessionResultFromResponse(
      await serverGetSession(
        { AUTH: signedOutAuth },
        new Request("https://uploads.sh/account/profile"),
      ),
    );
    expect(signedOut).toEqual({ kind: "signed_out" });

    const hang = hangingBinding();
    const timedOut = await sessionResultFromResponse(
      await serverGetSession(
        { AUTH: { fetch: hang } },
        new Request("https://uploads.sh/account/profile"),
        20,
      ),
    );
    expect(timedOut).toEqual({ kind: "unavailable", reason: "server" });
  });

  it("normal, fast responses are unaffected by the timeout plumbing", async () => {
    const { AUTH, fetchMock } = fakeAuthBinding(Response.json({ user: { id: "1" } }));
    const request = new Request("https://uploads.sh/account/profile", {
      headers: { cookie: "better-auth.session_token=abc" },
    });

    const response = await serverGetSession({ AUTH }, request);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: { id: "1" } });
  });
});

describe("proxyAuthRequest — no timeout on general traffic", () => {
  it("a hanging binding fetch leaves proxyAuthRequest unsettled (plain proxyAuthRequest carries no timeout)", async () => {
    const hang = hangingBinding();
    const request = new Request("https://uploads.sh/api/auth/sign-in/social", { method: "POST" });

    let settled = false;
    proxyAuthRequest({ AUTH: { fetch: hang } }, request).then(() => {
      settled = true;
    });

    // Give any pending microtasks/timers a chance to fire; a bound request
    // would already have rejected here, an unbound one must not have.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
  });

  it("does not attach a signal to the forwarded request", async () => {
    const { AUTH, fetchMock } = fakeAuthBinding(Response.json({ ok: true }));
    const request = new Request("https://uploads.sh/api/auth/sign-in/social", { method: "POST" });

    await proxyAuthRequest({ AUTH }, request);

    const forwarded = fetchMock.mock.calls[0]?.[0] as Request;
    expect(forwarded.signal.aborted).toBe(false);
  });
});

describe("proxyAuthRequest — bounded browser get-session", () => {
  it("settles with a synthetic 503 when the binding hangs on GET get-session", async () => {
    const hang = hangingBinding();
    const request = new Request("https://uploads.sh/api/auth/get-session");

    const response = await proxyAuthRequest({ AUTH: { fetch: hang } }, request, 20);

    expect(response.status).toBe(503);
    expect(await sessionResultFromResponse(response)).toEqual({
      kind: "unavailable",
      reason: "server",
    });
  });

  it("propagates the caller's own abort as a throw, not a synthetic 503", async () => {
    const hang = hangingBinding();
    const controller = new AbortController();
    const request = new Request("https://uploads.sh/api/auth/get-session", {
      signal: controller.signal,
    });

    const pending = proxyAuthRequest({ AUTH: { fetch: hang } }, request, 5_000);
    controller.abort(new DOMException("gone", "AbortError"));

    await expect(pending).rejects.toThrow();
  });

  it("normal GET get-session responses pass through untouched", async () => {
    const { AUTH } = fakeAuthBinding(Response.json({ user: { id: "1" } }));
    const request = new Request("https://uploads.sh/api/auth/get-session");

    const response = await proxyAuthRequest({ AUTH }, request, 20);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: { id: "1" } });
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
