import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { respondError } from "../error-response";
import { admin } from "./admin";

const ADMIN_TOKEN = "test-admin-token";

if (typeof crypto.subtle.timingSafeEqual !== "function") {
  (
    crypto.subtle as unknown as { timingSafeEqual: (a: Uint8Array, b: Uint8Array) => boolean }
  ).timingSafeEqual = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/**
 * Stub AUTH: `POST /internal/orgs` answers `createStatus` (201 new, 200
 * existing); `GET /internal/orgs/:slug/members` returns `members`.
 */
function stubAuth(opts: { createStatus: number; members?: unknown[] }) {
  const calls: string[] = [];
  const auth = {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const url = new URL(req.url);
      calls.push(`${req.method} ${url.pathname}`);
      if (req.method === "POST" && url.pathname === "/internal/orgs") {
        const body = (await req.json()) as { slug: string };
        return Response.json(
          { organization: { id: "org_1", slug: body.slug, name: body.slug } },
          { status: opts.createStatus },
        );
      }
      if (req.method === "GET" && url.pathname.endsWith("/members")) {
        return Response.json({ members: opts.members ?? [] });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    }) as Fetcher["fetch"],
  };
  return { auth, calls };
}

function appWith(auth: Pick<Fetcher, "fetch">) {
  const app = new Hono<{ Bindings: Env }>()
    .route("/admin", admin)
    .onError((err, c) => respondError(c, err));
  return { app, env: { ADMIN_TOKEN, AUTH: auth } as unknown as Env };
}

function createRequest(name: string, token: string | null = ADMIN_TOKEN) {
  return new Request(`https://api.uploads.sh/admin/orgs/${name}`, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe("POST /admin/orgs/:name", () => {
  it("creates a memberless org for the workspace name", async () => {
    const { auth, calls } = stubAuth({ createStatus: 201 });
    const { app, env } = appWith(auth);
    const res = await app.request(createRequest("acme"), {}, env);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      organization: { id: "org_1", slug: "acme", name: "acme" },
      created: true,
    });
    expect(calls).toEqual(["POST /internal/orgs"]);
  });

  it("is idempotent when a memberless org already exists", async () => {
    const { auth } = stubAuth({ createStatus: 200, members: [] });
    const { app, env } = appWith(auth);
    const res = await app.request(createRequest("acme"), {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ created: false });
  });

  it("409s when an existing org already has members", async () => {
    const { auth } = stubAuth({
      createStatus: 200,
      members: [{ id: "m1", userId: "u1", role: "owner", email: "a@x.com", name: "A" }],
    });
    const { app, env } = appWith(auth);
    const res = await app.request(createRequest("acme"), {}, env);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "org_has_members" } });
  });

  it("400s on an invalid workspace name without calling AUTH", async () => {
    const { auth, calls } = stubAuth({ createStatus: 201 });
    const { app, env } = appWith(auth);
    const res = await app.request(createRequest("Bad_Name"), {}, env);
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("401s without a valid admin token", async () => {
    const { auth, calls } = stubAuth({ createStatus: 201 });
    const { app, env } = appWith(auth);
    const res = await app.request(createRequest("acme", null), {}, env);
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });
});
