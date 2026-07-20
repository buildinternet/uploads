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
