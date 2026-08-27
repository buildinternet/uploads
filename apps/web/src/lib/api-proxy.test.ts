import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  proxyApiRequest,
  proxyEnrollmentJoinRequest,
  serverApiFetch,
  serverApiFetchImpl,
} from "./api-proxy";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Minimal binding fake — records the forwarded request and returns a canned response. */
function fakeApiBinding(response: Response) {
  const fetch = vi.fn(async (_req: Request) => response);
  return { API: { fetch }, fetchMock: fetch };
}

describe("proxyApiRequest — binding transport", () => {
  it("strips the leading /api and forwards over env.API with redirect: manual", async () => {
    const { API, fetchMock } = fakeApiBinding(Response.json({ ok: true }));
    const request = new Request("https://uploads.sh/api/me/workspaces", {
      headers: { cookie: "better-auth.session_token=abc" },
    });

    await proxyApiRequest({ API }, request);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const forwarded = fetchMock.mock.calls[0]?.[0] as Request;
    expect(forwarded.url).toBe("https://uploads.sh/me/workspaces");
    expect(forwarded.redirect).toBe("manual");
    expect(forwarded.headers.get("cookie")).toBe("better-auth.session_token=abc");
  });

  it("preserves the query string", async () => {
    const { API, fetchMock } = fakeApiBinding(Response.json({ ok: true }));
    const request = new Request("https://uploads.sh/api/v1/workspaces/acme/files?prefix=a%2Fb");

    await proxyApiRequest({ API }, request);

    const forwarded = fetchMock.mock.calls[0]?.[0] as Request;
    expect(forwarded.url).toBe("https://uploads.sh/v1/workspaces/acme/files?prefix=a%2Fb");
  });

  it("forwards method and body untouched", async () => {
    const { API, fetchMock } = fakeApiBinding(Response.json({ ok: true }));
    const request = new Request("https://uploads.sh/api/v1/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"grants":[]}',
    });

    await proxyApiRequest({ API }, request);

    const forwarded = fetchMock.mock.calls[0]?.[0] as Request;
    expect(forwarded.method).toBe("POST");
    expect(forwarded.headers.get("content-type")).toBe("application/json");
    expect(await forwarded.text()).toBe('{"grants":[]}');
  });

  it("passes the upstream response through untouched", async () => {
    const upstream = Response.json({ hello: "world" }, { status: 201 });
    const { API } = fakeApiBinding(upstream);
    const request = new Request("https://uploads.sh/api/v1/tokens", { method: "POST" });

    const response = await proxyApiRequest({ API }, request);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ hello: "world" });
  });

  it("404s a stripped path starting with /auth, never reaching env.API", async () => {
    const { API, fetchMock } = fakeApiBinding(Response.json({ ok: true }));
    const request = new Request("https://uploads.sh/api/auth/enrollments/xyz");

    const response = await proxyApiRequest({ API }, request);

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404s an encoded /auth further down the path (/api/%61uth/...), never reaching env.API", async () => {
    const { API, fetchMock } = fakeApiBinding(Response.json({ ok: true }));
    const request = new Request("https://uploads.sh/api/%61uth/enrollments/xyz");

    const response = await proxyApiRequest({ API }, request);

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404s an encoded /api boundary slash (/api%2Fauth/...), never reaching env.API", async () => {
    const { API, fetchMock } = fakeApiBinding(Response.json({ ok: true }));
    const request = new Request("https://uploads.sh/api%2Fauth/enrollments/xyz");

    const response = await proxyApiRequest({ API }, request);

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404s a malformed percent-escape rather than guessing", async () => {
    const { API, fetchMock } = fakeApiBinding(Response.json({ ok: true }));
    const request = new Request("https://uploads.sh/api/v1/workspaces/acme/files/%");

    const response = await proxyApiRequest({ API }, request);

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("proxyApiRequest — HTTP fallback transport", () => {
  it("rewrites only the origin, stripping /api and keeping path/query/method/headers/body", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const req = input as Request;
      expect(req.url).toBe("http://127.0.0.1:8787/v1/workspaces/acme/files?prefix=x");
      expect(req.method).toBe("POST");
      expect(req.redirect).toBe("manual");
      expect(req.headers.get("content-type")).toBe("application/json");
      expect(await req.text()).toBe('{"name":"acme"}');
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = new Request("https://uploads.sh/api/v1/workspaces/acme/files?prefix=x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"name":"acme"}',
    });

    await proxyApiRequest({}, request);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("defaults to http://127.0.0.1:8787 when UPLOADS_API_ORIGIN is unset", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect((input as Request).url).toMatch(/^http:\/\/127\.0\.0\.1:8787\//);
      return Response.json(null);
    });
    vi.stubGlobal("fetch", fetchMock);

    await proxyApiRequest({}, new Request("https://uploads.sh/api/me/workspaces"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses UPLOADS_API_ORIGIN when provided", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect((input as Request).url).toBe("https://api.uploads.localhost/me/workspaces");
      return Response.json(null);
    });
    vi.stubGlobal("fetch", fetchMock);

    await proxyApiRequest(
      { UPLOADS_API_ORIGIN: "https://api.uploads.localhost" },
      new Request("https://uploads.localhost/api/me/workspaces"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("404s a stripped path starting with /auth without touching the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await proxyApiRequest(
      {},
      new Request("https://uploads.sh/api/auth/enrollments/xyz"),
    );

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("serverApiFetch", () => {
  it("targets the given path on the request's own origin and forwards its cookie header", async () => {
    const { API, fetchMock } = fakeApiBinding(Response.json({ workspaces: [] }));
    const request = new Request("https://uploads.sh/account/workspaces", {
      headers: { cookie: "better-auth.session_token=abc" },
    });

    await serverApiFetch({ API }, request, "/api/me/workspaces");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const forwarded = fetchMock.mock.calls[0]?.[0] as Request;
    expect(forwarded.url).toBe("https://uploads.sh/me/workspaces");
    expect(forwarded.headers.get("cookie")).toBe("better-auth.session_token=abc");
  });

  it("sends an empty cookie header when the incoming request has none", async () => {
    const { API, fetchMock } = fakeApiBinding(Response.json(null));
    const request = new Request("https://uploads.sh/account/workspaces");

    await serverApiFetch({ API }, request, "/api/me/workspaces");

    const forwarded = fetchMock.mock.calls[0]?.[0] as Request;
    expect(forwarded.headers.get("cookie")).toBe("");
  });

  it("passes method/init through", async () => {
    const { API, fetchMock } = fakeApiBinding(Response.json({ ok: true }));
    const request = new Request("https://uploads.sh/account/workspaces/acme/settings");

    await serverApiFetch({ API }, request, "/api/v1/workspaces/acme/storage", {
      method: "DELETE",
    });

    const forwarded = fetchMock.mock.calls[0]?.[0] as Request;
    expect(forwarded.method).toBe("DELETE");
    expect(forwarded.url).toBe("https://uploads.sh/v1/workspaces/acme/storage");
  });

  it("does not overwrite a cookie header the caller's init already set (matches serverAuthFetch)", async () => {
    const { API, fetchMock } = fakeApiBinding(Response.json({ ok: true }));
    const request = new Request("https://uploads.sh/account/workspaces", {
      headers: { cookie: "better-auth.session_token=incoming" },
    });

    await serverApiFetch({ API }, request, "/api/me/workspaces", {
      headers: { cookie: "better-auth.session_token=caller-set" },
    });

    const forwarded = fetchMock.mock.calls[0]?.[0] as Request;
    expect(forwarded.headers.get("cookie")).toBe("better-auth.session_token=caller-set");
  });
});

describe("serverApiFetchImpl", () => {
  it("adapts serverApiFetch to a fetch(input, init) shape for api-client's fetchImpl", async () => {
    const { API, fetchMock } = fakeApiBinding(Response.json({ workspaces: [] }));
    const request = new Request("https://uploads.sh/account/workspaces", {
      headers: { cookie: "better-auth.session_token=abc" },
    });

    const fetchImpl = serverApiFetchImpl({ API }, request);
    const response = await fetchImpl("/api/me/workspaces", { cache: "no-store" });

    expect(await response.json()).toEqual({ workspaces: [] });
    const forwarded = fetchMock.mock.calls[0]?.[0] as Request;
    expect(forwarded.url).toBe("https://uploads.sh/me/workspaces");
    expect(forwarded.headers.get("cookie")).toBe("better-auth.session_token=abc");
  });
});

describe("proxyApiRequest — Server-Timing wiring (issue #812)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("emits an api;dur=… Server-Timing header on the returned response", async () => {
    const { API } = fakeApiBinding(Response.json({ ok: true }));
    const request = new Request("https://uploads.sh/api/me/workspaces");

    const response = await proxyApiRequest({ API }, request);
    expect(response.headers.get("Server-Timing")).toMatch(/^api;dur=\d+(\.\d+)?$/);
  });

  it("silences the header when SERVER_TIMING_DISABLED is set", async () => {
    const { API } = fakeApiBinding(Response.json({ ok: true }));
    const request = new Request("https://uploads.sh/api/me/workspaces");

    const response = await proxyApiRequest({ API, SERVER_TIMING_DISABLED: "1" }, request);
    expect(response.headers.get("Server-Timing")).toBeNull();
  });

  it("logs a slow-op line only above the threshold", async () => {
    const { API } = fakeApiBinding(Response.json({ ok: true }));
    const request = new Request("https://uploads.sh/api/me/workspaces");

    await proxyApiRequest({ API, SLOW_OP_THRESHOLD_MS: "1000000" }, request);
    expect(logSpy).not.toHaveBeenCalled();

    await proxyApiRequest({ API, SLOW_OP_THRESHOLD_MS: "0" }, request);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(logged).toMatchObject({ msg: "slow_op", op: "api", outcome: "ok" });
  });

  it("never emits a header on the /auth guard's 404 (no upstream call was timed)", async () => {
    const request = new Request("https://uploads.sh/api/auth/get-session");
    const response = await proxyApiRequest({}, request);
    expect(response.status).toBe(404);
    expect(response.headers.get("Server-Timing")).toBeNull();
  });
});

// Issue #869 phase B: `POST /auth/enrollments/join` needs its own fixed-target
// route because `proxyApiRequest`'s generic `/api/[...path]` 404s every
// `/api/auth/*` path (that prefix is reserved for the Better Auth proxy).
describe("proxyEnrollmentJoinRequest", () => {
  it("forwards to /auth/enrollments/join over env.API, cookie and body intact", async () => {
    const { API, fetchMock } = fakeApiBinding(
      Response.json({ workspace: "acme", alreadyMember: false }),
    );
    const request = new Request("https://uploads.sh/api/enrollments/join", {
      method: "POST",
      headers: { cookie: "better-auth.session_token=abc", "content-type": "application/json" },
      body: JSON.stringify({ code: "upe_test" }),
    });

    const response = await proxyEnrollmentJoinRequest({ API }, request);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const forwarded = fetchMock.mock.calls[0]?.[0] as Request;
    expect(forwarded.url).toBe("https://uploads.sh/auth/enrollments/join");
    expect(forwarded.method).toBe("POST");
    expect(forwarded.redirect).toBe("manual");
    expect(forwarded.headers.get("cookie")).toBe("better-auth.session_token=abc");
    expect(await forwarded.text()).toBe(JSON.stringify({ code: "upe_test" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ workspace: "acme", alreadyMember: false });
  });

  it("passes the upstream error response through untouched (e.g. 401/403)", async () => {
    const { API } = fakeApiBinding(
      Response.json({ error: { code: "member_cap_reached" } }, { status: 403 }),
    );
    const request = new Request("https://uploads.sh/api/enrollments/join", {
      method: "POST",
      body: JSON.stringify({ code: "upe_test" }),
    });

    const response = await proxyEnrollmentJoinRequest({ API }, request);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "member_cap_reached" } });
  });

  it("falls back to HTTP when no API binding is configured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: true })),
    );
    const request = new Request("https://uploads.sh/api/enrollments/join", {
      method: "POST",
      body: "{}",
    });

    await proxyEnrollmentJoinRequest({ UPLOADS_API_ORIGIN: "https://api.example.com" }, request);

    const forwarded = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Request;
    expect(forwarded.url).toBe("https://api.example.com/auth/enrollments/join");
  });
});
