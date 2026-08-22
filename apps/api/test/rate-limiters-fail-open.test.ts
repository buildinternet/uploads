/**
 * The five apps/api rate limiters (WRITE_LIMITER, RENDER_LIMITER,
 * WS_CREATE_LIMITER, INVITE_LIMITER — POSTER_LIMITER is covered separately in
 * poster-gate.test.ts, since it fails *closed* by design) are optional
 * bindings (issue #754 item 3): every guard already fails open when its
 * binding is absent, but until now nothing pinned that behavior with a
 * dedicated absent-binding test. These do.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { respondError } from "../src/error-response";
import { allowRender, allowWorkspaceCreate, allowWrite } from "../src/guards";
import { auth } from "../src/routes/auth";

const authApp = new Hono<{ Bindings: Env }>()
  .route("/", auth)
  .onError((err, c) => respondError(c, err));

describe("guards.ts rate limiters — binding absent fails open", () => {
  it("allowWrite (WRITE_LIMITER) allows when the binding is absent", async () => {
    await expect(allowWrite({}, "acme")).resolves.toBe(true);
  });

  it("allowWrite (WRITE_LIMITER) still enforces the limit when the binding is present", async () => {
    const env = { WRITE_LIMITER: { limit: async () => ({ success: false }) } };
    await expect(allowWrite(env, "acme")).resolves.toBe(false);
  });

  it("allowRender (RENDER_LIMITER) allows when the binding is absent", async () => {
    await expect(allowRender({}, "acme")).resolves.toBe(true);
  });

  it("allowWorkspaceCreate (WS_CREATE_LIMITER) allows when the binding is absent", async () => {
    await expect(allowWorkspaceCreate({}, "user-1")).resolves.toBe(true);
  });

  it("allowWorkspaceCreate (WS_CREATE_LIMITER) still enforces the limit when present", async () => {
    const env = { WS_CREATE_LIMITER: { limit: async () => ({ success: false }) } };
    await expect(allowWorkspaceCreate(env, "user-1")).resolves.toBe(false);
  });
});

describe("INVITE_LIMITER absent — /enrollments/:pageId never 429s", () => {
  function envWithout(): Env {
    return { INVITE_LIMITER: undefined, DB: {} } as unknown as Env;
  }

  it("falls through to the handler's own response instead of rate-limiting", async () => {
    const res = await authApp.request(
      "/enrollments/not-a-real-page-id",
      { headers: { "CF-Connecting-IP": "203.0.113.1" } },
      envWithout(),
    );
    // findEnrollmentPage rejects the malformed pageId before ever touching
    // DB, so the meaningful assertion here is that the guard let the request
    // through at all (never a 429) rather than the exact 4xx code.
    expect(res.status).not.toBe(429);
  });

  it("429s when INVITE_LIMITER is present and denies", async () => {
    const env = {
      INVITE_LIMITER: { limit: async () => ({ success: false }) },
      DB: {},
    } as unknown as Env;
    const res = await authApp.request(
      "/enrollments/not-a-real-page-id",
      { headers: { "CF-Connecting-IP": "203.0.113.1" } },
      env,
    );
    expect(res.status).toBe(429);
  });
});
