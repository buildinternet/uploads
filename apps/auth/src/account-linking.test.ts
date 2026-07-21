/**
 * Issue #233 — account-linking policy: a GitHub sign-in whose GitHub-reported
 * email is verified attaches to an existing user with the same email
 * (including one that only ever signed in via magic link), while an
 * unverified GitHub email must never link — that's the account-takeover
 * vector the issue calls out. Driven against the real Better Auth handler
 * (`app` from ./index) and the fake-D1 harness, with `fetch` stubbed for
 * GitHub's token/userinfo endpoints (see apps/auth/src/auth.ts's
 * `account.accountLinking` config and its comment on why `trustedProviders`
 * is deliberately left empty).
 */
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthEnv } from "./auth";
import { app } from "./index";
import * as schema from "./schema";
import { createFakeD1, type FakeD1Database } from "./test/fake-d1";

function dbEnv(db: FakeD1Database, overrides: Partial<AuthEnv> = {}): AuthEnv {
  return {
    DB: db,
    WEB_ORIGIN: "https://uploads.sh",
    BETTER_AUTH_URL: "https://auth.uploads.sh",
    ENVIRONMENT: "development",
    BETTER_AUTH_SECRET_DEV: "test-signing-secret-at-least-32-chars-long",
    GITHUB_CLIENT_ID: "test-github-client-id",
    GITHUB_CLIENT_SECRET: "test-github-client-secret",
    ...overrides,
  };
}

type GithubEmail = { email: string; primary: boolean; verified: boolean };

function stubGithubFetch(
  profile: { id: number; login: string; email: string | null },
  emails: GithubEmail[],
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://github.com/login/oauth/access_token")) {
        return new Response(
          JSON.stringify({
            access_token: "gh-test-access-token",
            token_type: "bearer",
            scope: "read:user,user:email",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === "https://api.github.com/user") {
        return new Response(JSON.stringify(profile), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://api.github.com/user/emails") {
        return new Response(JSON.stringify(emails), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }),
  );
}

/** Start the GitHub OAuth dance, returning the callback's `state` param plus the cookies to forward. */
async function beginGithubSignIn(env: AuthEnv): Promise<{ state: string; cookie: string }> {
  const res = await app.request(
    "/api/auth/sign-in/social",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "github", callbackURL: "/" }),
    },
    env,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { url?: string };
  expect(body.url).toBeTruthy();
  const state = new URL(body.url!).searchParams.get("state");
  expect(state).toBeTruthy();
  const cookies = res.headers.getSetCookie?.() ?? [];
  const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
  return { state: state!, cookie };
}

async function completeGithubCallback(env: AuthEnv, state: string, cookie: string) {
  return app.request(
    `/api/auth/callback/github?code=test-code&state=${encodeURIComponent(state)}`,
    { headers: { cookie } },
    env,
  );
}

describe("account linking (issue #233)", () => {
  let db: FakeD1Database;
  let orm: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(() => {
    db = createFakeD1();
    orm = drizzle(db, { schema });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("attaches a verified-email GitHub sign-in to the existing magic-link user (no duplicate)", async () => {
    const email = "shared-verified@example.com";
    const userId = crypto.randomUUID();
    await orm.insert(schema.user).values({
      id: userId,
      name: "Magic Link User",
      email,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const env = dbEnv(db);
    const { state, cookie } = await beginGithubSignIn(env);
    stubGithubFetch({ id: 4242, login: "shared-user", email }, [
      { email, primary: true, verified: true },
    ]);

    const res = await completeGithubCallback(env, state, cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).not.toContain("error=");

    const users = await orm.select().from(schema.user).where(eq(schema.user.email, email));
    expect(users).toHaveLength(1);
    expect(users[0].id).toBe(userId);

    const accounts = await orm
      .select()
      .from(schema.account)
      .where(eq(schema.account.userId, userId));
    const githubAccount = accounts.find((a) => a.providerId === "github");
    expect(githubAccount).toBeDefined();
    expect(githubAccount?.accountId).toBe("4242");
  });

  it("does NOT link an unverified GitHub email to an existing verified user", async () => {
    const email = "shared-unverified@example.com";
    const userId = crypto.randomUUID();
    await orm.insert(schema.user).values({
      id: userId,
      name: "Magic Link User",
      email,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const env = dbEnv(db);
    const { state, cookie } = await beginGithubSignIn(env);
    stubGithubFetch({ id: 9999, login: "unverified-user", email }, [
      { email, primary: true, verified: false },
    ]);

    const res = await completeGithubCallback(env, state, cookie);
    // better-auth redirects to the error callback rather than linking or
    // silently minting a second user for the same email.
    expect(res.status).toBe(302);

    const users = await orm.select().from(schema.user).where(eq(schema.user.email, email));
    expect(users).toHaveLength(1);
    expect(users[0].id).toBe(userId);
    expect(users[0].emailVerified).toBe(true);

    const accounts = await orm
      .select()
      .from(schema.account)
      .where(eq(schema.account.userId, userId));
    expect(accounts.find((a) => a.providerId === "github")).toBeUndefined();
  });

  it("still creates a brand-new user for a fresh, verified GitHub sign-in (no existing email match)", async () => {
    const email = "brand-new@example.com";
    const env = dbEnv(db);
    const { state, cookie } = await beginGithubSignIn(env);
    stubGithubFetch({ id: 1234, login: "new-user", email }, [
      { email, primary: true, verified: true },
    ]);

    const res = await completeGithubCallback(env, state, cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).not.toContain("error=");

    const users = await orm.select().from(schema.user).where(eq(schema.user.email, email));
    expect(users).toHaveLength(1);
    expect(users[0].emailVerified).toBe(true);
  });
});
