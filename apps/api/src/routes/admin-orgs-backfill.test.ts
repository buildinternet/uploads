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

function stubAuth(handler: (req: Request) => Response | Promise<Response>): Pick<Fetcher, "fetch"> {
  return {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      return handler(req);
    }) as Fetcher["fetch"],
  };
}

function fakeKv(names: string[]): Pick<KVNamespace, "list"> {
  return {
    list: (async () => ({
      keys: names.map((name) => ({ name: `ws:${name}` })),
      list_complete: true,
      cacheStatus: null,
    })) as unknown as KVNamespace["list"],
  };
}

function appWith(auth: Pick<Fetcher, "fetch">, kv: Pick<KVNamespace, "list">) {
  const app = new Hono<{ Bindings: Env }>()
    .route("/admin", admin)
    .onError((err, c) => respondError(c, err));
  return { app, env: { ADMIN_TOKEN, AUTH: auth, REGISTRY: kv } as unknown as Env };
}

function backfillRequest() {
  return new Request("https://api.uploads.sh/admin/orgs/backfill", {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
}

describe("POST /admin/orgs/backfill", () => {
  it("creates an org per workspace and reports created vs existing", async () => {
    const auth = stubAuth((req) => {
      expect(req.headers.get("x-uploads-internal")).toBe("1");
      return new Response(
        JSON.stringify({ organization: { id: "x", slug: "acme", name: "acme" } }),
        {
          status: 201,
        },
      );
    });
    const { app, env } = appWith(auth, fakeKv(["acme", "beta"]));
    const res = await app.request(backfillRequest(), {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: ["acme", "beta"], existing: [] });
  });

  it("reports existing orgs as existing (idempotent re-run), not created", async () => {
    const auth = stubAuth(
      () =>
        new Response(JSON.stringify({ organization: { id: "x", slug: "acme", name: "acme" } }), {
          status: 200,
        }),
    );
    const { app, env } = appWith(auth, fakeKv(["acme"]));
    const res = await app.request(backfillRequest(), {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: [], existing: ["acme"] });
  });

  it("401s without a valid admin token", async () => {
    const auth = stubAuth(() => new Response("{}", { status: 200 }));
    const { app, env } = appWith(auth, fakeKv([]));
    const req = new Request("https://api.uploads.sh/admin/orgs/backfill", { method: "POST" });
    const res = await app.request(req, {}, env);
    expect(res.status).toBe(401);
  });

  it("surfaces an auth-worker failure as an error rather than silently continuing", async () => {
    const auth = stubAuth(() => new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
    const { app, env } = appWith(auth, fakeKv(["acme"]));
    const res = await app.request(backfillRequest(), {}, env);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
