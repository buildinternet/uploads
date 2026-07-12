import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AuthEnv } from "./auth";
import { internal } from "./internal-routes";

/**
 * These cover the request-validation short-circuits on the Phase 3
 * `/internal/*` routes (memberships/orgs/invite) that fail before touching
 * D1 — validated by using a DB stub that throws on first access. Full
 * DB-backed behavior (successful creates/lookups against real `organization`/
 * `member`/`invitation` rows) is NOT covered here: this repo has no
 * drizzle-over-D1 test harness yet (unlike apps/api's hand-rolled FakeD1 for
 * raw SQL in auth-db.test.ts, drizzle's D1 driver issues its own prepared
 * statements that a hand-written fake would need to parse). Flagged in the
 * Phase 3 handoff report as a follow-up rather than built here.
 */
function poisonDB(): D1Database {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("DB should not be touched for this request");
      },
    },
  ) as D1Database;
}

function app() {
  return new Hono<{ Bindings: AuthEnv }>().route("/internal", internal);
}

function env(): AuthEnv {
  return { DB: poisonDB(), WEB_ORIGIN: "https://uploads.sh", ENVIRONMENT: "development" };
}

describe("GET /internal/memberships", () => {
  it("400s when userId is missing", async () => {
    const res = await app().request("/internal/memberships", {}, env());
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "invalid_user_id" },
    });
  });
});

describe("POST /internal/orgs", () => {
  it("400s when slug is missing", async () => {
    const res = await app().request(
      "/internal/orgs",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) },
      env(),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "invalid_slug" },
    });
  });
});

describe("POST /internal/invite", () => {
  it("400s when required fields are missing", async () => {
    const res = await app().request(
      "/internal/invite",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) },
      env(),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "invalid_request" },
    });
  });

  it("400s on an invalid role without touching the DB", async () => {
    const res = await app().request(
      "/internal/invite",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationSlug: "acme",
          email: "a@b.com",
          role: "owner",
          inviterUserId: "u1",
        }),
      },
      env(),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "invalid_role" },
    });
  });
});
