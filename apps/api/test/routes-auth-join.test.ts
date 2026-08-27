/**
 * Issue #869 phase B: `POST /auth/enrollments/join` — redeems a
 * workspace-admin `kind: 'member'` invite link as org membership (never a
 * CLI token; that's `/auth/enrollments/exchange`, `kind: 'token'` only).
 * Exercised through the real composed `app` (index.ts), same style as
 * `routes-workspace-members.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { createEnrollment } from "../src/auth-db";
import { app } from "../src/index";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const MIGRATIONS = [
  "migrations/20260710120000_auth.sql",
  "migrations/20260711120000_invite_pages.sql",
  "migrations/20260712230000_token_minting_user.sql",
  "migrations/20260817180000_token_last_used.sql",
  "migrations/20260827160000_auth_enrollments_kind.sql",
];

const USER = { id: "u-joiner", email: "joiner@example.com", name: "Joiner" };

function stubAuth(handler: (req: Request) => Response | Promise<Response>): Pick<Fetcher, "fetch"> {
  return {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      return handler(req);
    }) as Fetcher["fetch"],
  };
}

interface EnvOpts {
  sessionUser?: typeof USER | null;
  db?: SqliteD1;
  joinResponse?: (body: { organizationSlug?: string; userId?: string }) => Response;
  inviteAllowed?: boolean;
  joinCalls?: { count: number };
}

function makeEnv(opts: EnvOpts = {}) {
  const {
    sessionUser = USER,
    db = new SqliteD1(MIGRATIONS),
    joinResponse,
    inviteAllowed,
    joinCalls,
  } = opts;

  const auth = stubAuth(async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/api/auth/get-session") {
      return sessionUser
        ? Response.json({ session: {}, user: sessionUser })
        : new Response(null, { status: 401 });
    }
    if (url.pathname === "/internal/join" && req.method === "POST") {
      if (joinCalls) joinCalls.count++;
      const body = (await req.json()) as { organizationSlug?: string; userId?: string };
      if (joinResponse) return joinResponse(body);
      return Response.json({ alreadyMember: false }, { status: 201 });
    }
    return new Response(null, { status: 404 });
  });

  const env = { AUTH: auth, DB: database(db) } as unknown as Env;
  if (inviteAllowed !== undefined) {
    (env as unknown as { INVITE_LIMITER: unknown }).INVITE_LIMITER = {
      limit: async () => ({ success: inviteAllowed }),
    };
  }
  return env;
}

const sessionHeaders = { cookie: "session=x", "content-type": "application/json" };

async function mintMemberLink(db: SqliteD1, workspace = "acme") {
  return createEnrollment(database(db) as unknown as D1Database, {
    workspace,
    scopes: [],
    kind: "member",
  });
}

async function mintTokenLink(db: SqliteD1, workspace = "acme") {
  return createEnrollment(database(db) as unknown as D1Database, {
    workspace,
    scopes: ["files:read"],
  });
}

describe("POST /auth/enrollments/join", () => {
  it("adds the signed-in user as a member and marks the link used", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const link = await mintMemberLink(db);
    const res = await app.request(
      "/auth/enrollments/join",
      { method: "POST", headers: sessionHeaders, body: JSON.stringify({ code: link.code }) },
      makeEnv({ db }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspace: "acme", alreadyMember: false });

    // Single-use: a second redemption of the same code is rejected uniformly.
    const replay = await app.request(
      "/auth/enrollments/join",
      { method: "POST", headers: sessionHeaders, body: JSON.stringify({ code: link.code }) },
      makeEnv({ db }),
    );
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: { code: string } }).error.code).toBe(
      "invalid_enrollment",
    );
  });

  it("passes through alreadyMember: true without erroring", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const link = await mintMemberLink(db);
    const res = await app.request(
      "/auth/enrollments/join",
      { method: "POST", headers: sessionHeaders, body: JSON.stringify({ code: link.code }) },
      makeEnv({ db, joinResponse: () => Response.json({ alreadyMember: true }, { status: 200 }) }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspace: "acme", alreadyMember: true });
  });

  it("403s with member_cap_reached on cap denial, and restores the link (not burned)", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const link = await mintMemberLink(db);
    const res = await app.request(
      "/auth/enrollments/join",
      { method: "POST", headers: sessionHeaders, body: JSON.stringify({ code: link.code }) },
      makeEnv({
        db,
        joinResponse: () =>
          Response.json(
            {
              error: {
                code: "member_cap_reached",
                message: "This workspace has reached its member limit.",
              },
            },
            { status: 403 },
          ),
      }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "member_cap_reached",
    );

    // The link was NOT burned — a later successful join call still works.
    const retry = await app.request(
      "/auth/enrollments/join",
      { method: "POST", headers: sessionHeaders, body: JSON.stringify({ code: link.code }) },
      makeEnv({ db }),
    );
    expect(retry.status).toBe(200);
  });

  it("restores the link on a transient auth-worker failure too", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const link = await mintMemberLink(db);
    const res = await app.request(
      "/auth/enrollments/join",
      { method: "POST", headers: sessionHeaders, body: JSON.stringify({ code: link.code }) },
      makeEnv({ db, joinResponse: () => new Response(null, { status: 500 }) }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "invalid_enrollment",
    );

    const retry = await app.request(
      "/auth/enrollments/join",
      { method: "POST", headers: sessionHeaders, body: JSON.stringify({ code: link.code }) },
      makeEnv({ db }),
    );
    expect(retry.status).toBe(200);
  });

  it("rejects a token-kind code uniformly (not exchangeable for membership)", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const link = await mintTokenLink(db);
    const joinCalls = { count: 0 };
    const res = await app.request(
      "/auth/enrollments/join",
      { method: "POST", headers: sessionHeaders, body: JSON.stringify({ code: link.code }) },
      makeEnv({ db, joinCalls }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "invalid_enrollment",
    );
    // Never even reaches the auth worker's member-add path.
    expect(joinCalls.count).toBe(0);
  });

  it("rejects an expired member-kind code uniformly", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const past = new Date("2020-01-01T00:00:00.000Z");
    const link = await createEnrollment(database(db) as unknown as D1Database, {
      workspace: "acme",
      scopes: [],
      kind: "member",
      enrollmentSeconds: 60,
      now: past,
    });
    const res = await app.request(
      "/auth/enrollments/join",
      { method: "POST", headers: sessionHeaders, body: JSON.stringify({ code: link.code }) },
      makeEnv({ db }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "invalid_enrollment",
    );
  });

  it("rejects an unknown code uniformly", async () => {
    const res = await app.request(
      "/auth/enrollments/join",
      {
        method: "POST",
        headers: sessionHeaders,
        body: JSON.stringify({ code: `upe_${"a".repeat(24)}` }),
      },
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "invalid_enrollment",
    );
  });

  it("401s when not signed in, without ever claiming the link", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const link = await mintMemberLink(db);
    const res = await app.request(
      "/auth/enrollments/join",
      { method: "POST", headers: sessionHeaders, body: JSON.stringify({ code: link.code }) },
      makeEnv({ db, sessionUser: null }),
    );
    expect(res.status).toBe(401);

    // The link is still redeemable — signing out and back in doesn't burn it.
    const retry = await app.request(
      "/auth/enrollments/join",
      { method: "POST", headers: sessionHeaders, body: JSON.stringify({ code: link.code }) },
      makeEnv({ db }),
    );
    expect(retry.status).toBe(200);
  });

  it("enforces its own rate-limit quota, keyed separately from exchange/lookup", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const link = await mintMemberLink(db);
    const res = await app.request(
      "/auth/enrollments/join",
      { method: "POST", headers: sessionHeaders, body: JSON.stringify({ code: link.code }) },
      makeEnv({ db, inviteAllowed: false }),
    );
    expect(res.status).toBe(429);
  });

  it("uses the same 1KB/single-key/prefix hygiene as exchange", async () => {
    const bodies = [
      "{}",
      "null",
      JSON.stringify({ code: "upe_bad" }),
      JSON.stringify({ code: `upe_${"a".repeat(24)}`, extra: true }),
    ];
    const env = makeEnv();
    const responses = await Promise.all(
      bodies.map((body) =>
        app.request(
          "/auth/enrollments/join",
          { method: "POST", headers: sessionHeaders, body },
          env,
        ),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual([400, 400, 400, 400]);
  });
});
