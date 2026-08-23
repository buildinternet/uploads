/**
 * D1 Sessions API wiring (issue #808). Confirms the top-level app creates one
 * Session per request via the `db.withSession(...)` binding call, and that
 * `dbFor` picks it up (falling back to the raw binding when no session was
 * created).
 */
import { describe, expect, it } from "vitest";
import { app } from "./index";
import { dbFor } from "./db-session";

function fakeDb(withSession: (constraint?: string) => unknown) {
  return { prepare: () => ({}), batch: () => Promise.resolve([]), withSession };
}

describe("D1 Sessions API middleware", () => {
  it("creates one session per request via db.withSession('first-unconstrained')", async () => {
    const calls: (string | undefined)[] = [];
    const session = { prepare: () => ({}), batch: () => Promise.resolve([]) };
    const env = {
      DB: fakeDb((constraint) => {
        calls.push(constraint);
        return session;
      }),
    } as unknown as Env;

    await app.request("https://api.uploads.sh/health", {}, env);

    expect(calls).toEqual(["first-unconstrained"]);
    expect(env.DB_SESSION).toBe(session);
  });

  it("calls withSession again for a second request (one session per request, not shared)", async () => {
    let sessionCount = 0;
    const env = {
      DB: fakeDb(() => {
        sessionCount++;
        return { id: sessionCount };
      }),
    } as unknown as Env;

    await app.request("https://api.uploads.sh/health", {}, env);
    await app.request("https://api.uploads.sh/health", {}, env);

    expect(sessionCount).toBe(2);
  });

  it("skips session creation when the DB binding has no withSession (plain test fakes)", async () => {
    const env = { DB: { prepare: () => ({}), batch: () => Promise.resolve([]) } } as unknown as Env;

    await app.request("https://api.uploads.sh/health", {}, env);

    expect(env.DB_SESSION).toBeUndefined();
  });

  it("skips session creation when DB is absent", async () => {
    const env = {} as unknown as Env;

    await app.request("https://api.uploads.sh/health", {}, env);

    expect(env.DB_SESSION).toBeUndefined();
  });
});

describe("dbFor", () => {
  it("prefers the per-request session over the raw binding", () => {
    const session = { tag: "session" };
    const db = { tag: "raw" };
    const env = { DB: db, DB_SESSION: session } as unknown as Env;

    expect(dbFor(env)).toBe(session);
  });

  it("falls back to the raw binding when no session was created", () => {
    const db = { tag: "raw" };
    const env = { DB: db } as unknown as Env;

    expect(dbFor(env)).toBe(db);
  });
});
