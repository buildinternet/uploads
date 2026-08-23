import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { respondError } from "./error-response";
import {
  requireAdminUser,
  requireSessionUser,
  sessionAuth,
  userHasAdminRole,
  type SessionVars,
} from "./session-auth";

/** Stub matching the Fetcher interface's `.fetch()` shape used by env.AUTH. */
function stubAuth(handler: (req: Request) => Response | Promise<Response>): Pick<Fetcher, "fetch"> {
  return {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      return handler(req);
    }) as Fetcher["fetch"],
  };
}

function appWith(_auth: Pick<Fetcher, "fetch">) {
  return new Hono<SessionVars>()
    .use("/*", sessionAuth)
    .get("/whoami", (c) => c.json({ sessionUser: c.get("sessionUser") }))
    .get("/private", requireSessionUser, (c) => c.json({ ok: true }))
    .get("/admin-only", requireAdminUser, (c) => c.json({ ok: true }))
    .onError((err, c) => respondError(c, err));
}

function env(auth: Pick<Fetcher, "fetch">) {
  return { AUTH: auth } as unknown as Env;
}

describe("sessionAuth", () => {
  it("treats a banned session user as signed out", async () => {
    const user = {
      id: "u1",
      email: "banned@example.com",
      name: "Banned",
      banned: true,
    };
    const auth = stubAuth(
      () => new Response(JSON.stringify({ session: {}, user }), { status: 200 }),
    );
    const res = await appWith(auth).request("/whoami", {}, env(auth));
    expect(await res.json()).toEqual({ sessionUser: null });
  });

  it("sets sessionUser to null when there is no cookie/session", async () => {
    const auth = stubAuth(() => new Response(JSON.stringify(null), { status: 200 }));
    const res = await appWith(auth).request("/whoami", {}, env(auth));
    expect(await res.json()).toEqual({ sessionUser: null });
  });

  it("returns 503 when the auth worker returns malformed JSON", async () => {
    const auth = stubAuth(() => new Response("not json", { status: 200 }));
    const res = await appWith(auth).request("/whoami", {}, env(auth));
    expect(res.status).toBe(503);
    expect((await res.json()) as { error?: { code?: string } }).toMatchObject({
      error: { code: "auth_session_unavailable" },
    });
  });

  it("returns 503 when the auth worker fetch throws", async () => {
    const auth: Pick<Fetcher, "fetch"> = {
      fetch: (() => {
        throw new Error("network down");
      }) as Fetcher["fetch"],
    };
    const res = await appWith(auth).request("/whoami", {}, env(auth));
    expect(res.status).toBe(503);
    expect((await res.json()) as { error?: { code?: string } }).toMatchObject({
      error: { code: "auth_session_unavailable" },
    });
  });

  it("returns 503 when the auth worker itself is unavailable", async () => {
    const auth = stubAuth(() => new Response(null, { status: 503 }));
    const res = await appWith(auth).request("/private", {}, env(auth));
    expect(res.status).toBe(503);
    expect((await res.json()) as { error?: { code?: string } }).toMatchObject({
      error: { code: "auth_session_unavailable" },
    });
  });

  it("sets sessionUser for a valid non-admin user, and requireAdminUser 403s", async () => {
    const user = { id: "u1", email: "a@b.com", name: "A", role: "user" };
    const auth = stubAuth(
      () => new Response(JSON.stringify({ session: {}, user }), { status: 200 }),
    );
    const whoami = await appWith(auth).request("/whoami", {}, env(auth));
    expect(await whoami.json()).toEqual({ sessionUser: user });

    const priv = await appWith(auth).request("/private", {}, env(auth));
    expect(priv.status).toBe(200);

    const adminOnly = await appWith(auth).request("/admin-only", {}, env(auth));
    expect(adminOnly.status).toBe(403);
  });

  it("allows requireAdminUser for a session user with role admin", async () => {
    const user = { id: "u2", email: "admin@b.com", name: "Admin", role: "admin" };
    const auth = stubAuth(
      () => new Response(JSON.stringify({ session: {}, user }), { status: 200 }),
    );
    const res = await appWith(auth).request("/admin-only", {}, env(auth));
    expect(res.status).toBe(200);
  });

  it("requireSessionUser 401s when there is no session", async () => {
    const auth = stubAuth(() => new Response(JSON.stringify(null), { status: 200 }));
    const res = await appWith(auth).request("/private", {}, env(auth));
    expect(res.status).toBe(401);
  });

  it("attaches a bounded AbortSignal to the AUTH get-session fetch", async () => {
    let seenSignal: AbortSignal | undefined;
    const auth: Pick<Fetcher, "fetch"> = {
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seenSignal = init?.signal ?? undefined;
        return new Response(JSON.stringify(null), { status: 200 });
      }) as Fetcher["fetch"],
    };
    await appWith(auth).request("/whoami", {}, env(auth));
    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });

  it("returns 503 auth_session_unavailable (not a hang) when the AUTH fetch aborts on timeout", async () => {
    // Simulates AbortSignal.timeout firing: a stalled AUTH binding rejects
    // with an AbortError instead of ever resolving. Regression guard for the
    // 2026-08-23 incident (D1 stalls propagating as unbounded hangs).
    const auth: Pick<Fetcher, "fetch"> = {
      fetch: (() =>
        Promise.reject(
          new DOMException("The operation was aborted.", "AbortError"),
        )) as Fetcher["fetch"],
    };
    const start = Date.now();
    const res = await appWith(auth).request("/whoami", {}, env(auth));
    expect(Date.now() - start).toBeLessThan(1000);
    expect(res.status).toBe(503);
    expect((await res.json()) as { error?: { code?: string } }).toMatchObject({
      error: { code: "auth_session_unavailable" },
    });
  });

  it("forwards the client IP headers to the auth worker", async () => {
    let seen: Headers | undefined;
    const auth = stubAuth((req) => {
      seen = req.headers;
      return new Response(JSON.stringify(null), { status: 200 });
    });
    await appWith(auth).request(
      "/whoami",
      {
        headers: { "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
      },
      env(auth),
    );
    expect(seen?.get("cf-connecting-ip")).toBe("203.0.113.7");
    expect(seen?.get("x-forwarded-for")).toBe("203.0.113.7, 10.0.0.1");
  });

  it("propagates an auth worker 429 as 429 auth_rate_limited with retry_after", async () => {
    // Better Auth's rate limiter emits `X-Retry-After` (not `Retry-After`).
    const auth = stubAuth(
      () => new Response(null, { status: 429, headers: { "x-retry-after": "42" } }),
    );
    const res = await appWith(auth).request("/whoami", {}, env(auth));
    expect(res.status).toBe(429);
    expect((await res.json()) as { error?: { code?: string } }).toMatchObject({
      error: { code: "auth_rate_limited", details: { retry_after: 42 } },
    });
  });

  it("falls back to a standard Retry-After header on a 429", async () => {
    const auth = stubAuth(
      () => new Response(null, { status: 429, headers: { "retry-after": "7" } }),
    );
    const res = await appWith(auth).request("/whoami", {}, env(auth));
    expect(res.status).toBe(429);
    expect((await res.json()) as { error?: { code?: string } }).toMatchObject({
      error: { code: "auth_rate_limited", details: { retry_after: 7 } },
    });
  });

  it("propagates an auth worker 429 without Retry-After as a bare 429", async () => {
    const auth = stubAuth(() => new Response(null, { status: 429 }));
    const res = await appWith(auth).request("/whoami", {}, env(auth));
    expect(res.status).toBe(429);
    expect((await res.json()) as { error?: { code?: string } }).toMatchObject({
      error: { code: "auth_rate_limited" },
    });
  });

  it("allows requireAdminUser for a multi-role user (comma-separated role)", async () => {
    const user = { id: "u3", email: "admin2@b.com", name: "Admin2", role: "admin,support" };
    const auth = stubAuth(
      () => new Response(JSON.stringify({ session: {}, user }), { status: 200 }),
    );
    const res = await appWith(auth).request("/admin-only", {}, env(auth));
    expect(res.status).toBe(200);
  });
});

describe("userHasAdminRole", () => {
  it("returns false for null/undefined user or role", () => {
    expect(userHasAdminRole(null)).toBe(false);
    expect(userHasAdminRole({ id: "1", email: "a@b.com", name: "A" })).toBe(false);
  });

  it("returns true for an exact 'admin' role", () => {
    expect(userHasAdminRole({ id: "1", email: "a@b.com", name: "A", role: "admin" })).toBe(true);
  });

  it("returns true for a comma-separated role list containing 'admin'", () => {
    expect(userHasAdminRole({ id: "1", email: "a@b.com", name: "A", role: "support,admin" })).toBe(
      true,
    );
  });

  it("returns false when 'admin' is not among the roles", () => {
    expect(userHasAdminRole({ id: "1", email: "a@b.com", name: "A", role: "support,editor" })).toBe(
      false,
    );
  });
});
