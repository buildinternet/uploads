import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { respondError } from "../error-response";
import { admin } from "./admin";

const ADMIN_TOKEN = "test-admin-token";

// `crypto.subtle.timingSafeEqual` is a Workers-runtime extension to Web
// Crypto (used by adminAuth, see ../admin.ts) that plain Node's `crypto`
// doesn't implement, and this repo has no vitest workerd pool configured.
// Polyfill a (non-constant-time, test-only) equivalent so this file can
// exercise the real adminAuth middleware end to end rather than bypassing it.
if (typeof crypto.subtle.timingSafeEqual !== "function") {
  (
    crypto.subtle as unknown as { timingSafeEqual: (a: Uint8Array, b: Uint8Array) => boolean }
  ).timingSafeEqual = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((byte, i) => byte === b[i]);
}

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
  return new Hono<{ Bindings: Env }>()
    .route("/admin", admin)
    .onError((err, c) => respondError(c, err));
}

function env(auth: Pick<Fetcher, "fetch">) {
  return { ADMIN_TOKEN, AUTH: auth } as unknown as Env;
}

function promoteRequest(email: unknown) {
  return new Request("https://api.uploads.sh/admin/users/promote", {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

describe("POST /admin/users/promote", () => {
  it("proxies to the auth worker and returns the promoted user", async () => {
    const auth = stubAuth((req) => {
      expect(req.headers.get("x-uploads-internal")).toBe("1");
      return new Response(
        JSON.stringify({ ok: true, user: { id: "u1", email: "a@b.com", role: "admin" } }),
        { status: 200 },
      );
    });
    const res = await appWith(auth).request(promoteRequest("a@b.com"), {}, env(auth));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      user: { id: "u1", email: "a@b.com", role: "admin" },
    });
  });

  it("surfaces the auth worker's 404 (no such user) as a 404", async () => {
    const auth = stubAuth(
      () =>
        new Response(
          JSON.stringify({ error: { code: "user_not_found", message: "no such user" } }),
          {
            status: 404,
          },
        ),
    );
    const res = await appWith(auth).request(promoteRequest("nobody@b.com"), {}, env(auth));
    expect(res.status).toBe(404);
  });

  it("rejects an invalid email without calling the auth worker", async () => {
    let called = false;
    const auth = stubAuth(() => {
      called = true;
      return new Response("{}", { status: 200 });
    });
    const res = await appWith(auth).request(promoteRequest("not-an-email"), {}, env(auth));
    expect(res.status).toBe(400);
    expect(called).toBe(false);
  });

  it("401s without a valid admin token", async () => {
    const auth = stubAuth(() => new Response("{}", { status: 200 }));
    const req = new Request("https://api.uploads.sh/admin/users/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@b.com" }),
    });
    const res = await appWith(auth).request(req, {}, env(auth));
    expect(res.status).toBe(401);
  });
});
