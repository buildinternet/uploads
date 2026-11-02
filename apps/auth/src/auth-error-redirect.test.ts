/**
 * Redirect sign-in failures must land on the web app's /auth/error page.
 * Magic-link verify otherwise appends ?error= to the success callbackURL,
 * and that page does not read it. An explicit errorCallbackURL still wins.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthEnv } from "./auth";
import { app } from "./index";
import { createFakeD1, type FakeD1Database } from "./test/fake-d1";

function envFor(db: FakeD1Database, overrides: Partial<AuthEnv> = {}): AuthEnv {
  return {
    DB: db,
    WEB_ORIGIN: "https://uploads.sh",
    BETTER_AUTH_URL: "https://auth.uploads.sh",
    ENVIRONMENT: "development",
    BETTER_AUTH_SECRET: "test-signing-secret-at-least-32-chars-long",
    ...overrides,
  };
}

function githubEnv(db: FakeD1Database): AuthEnv {
  return envFor(db, {
    GITHUB_CLIENT_ID: "test-github-client-id",
    GITHUB_CLIENT_SECRET: "test-github-client-secret",
  });
}

async function beginGithubSignIn(
  env: AuthEnv,
  errorCallbackURL?: string,
): Promise<{ state: string; cookie: string }> {
  const res = await app.request(
    "/api/auth/sign-in/social",
    {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://uploads.sh" },
      body: JSON.stringify({
        provider: "github",
        callbackURL: "https://uploads.sh/account",
        ...(errorCallbackURL ? { errorCallbackURL } : {}),
      }),
    },
    env,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { url?: string };
  const state = new URL(body.url!).searchParams.get("state");
  expect(state).toBeTruthy();
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  return { state: state!, cookie };
}

describe("sign-in error redirects", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps an explicit GitHub errorCallbackURL, including the error code", async () => {
    const env = githubEnv(createFakeD1());
    const { state, cookie } = await beginGithubSignIn(
      env,
      "https://uploads.sh/auth/error?from=github",
    );
    const res = await app.request(
      `/api/auth/callback/github?error=access_denied&state=${encodeURIComponent(state)}`,
      { headers: { cookie } },
      env,
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("https://uploads.sh/auth/error?")).toBe(true);
    expect(location).toContain("from=github");
    expect(location).toContain("error=access_denied");
    expect(location).not.toContain("/account");
  });

  it("sends a magic-link verify failure to /auth/error when the request omitted errorCallbackURL", async () => {
    const env = envFor(createFakeD1());
    const logged: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    let link: string | undefined;
    try {
      const res = await app.request(
        "/api/auth/sign-in/magic-link",
        {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://uploads.sh" },
          body: JSON.stringify({
            email: "person@example.com",
            callbackURL: "https://uploads.sh/account",
          }),
        },
        env,
      );
      expect(res.status).toBe(200);
      link = /Link: (\S+)/.exec(logged.join("\n"))?.[1];
    } finally {
      console.warn = warn;
    }
    expect(link).toBeTruthy();
    const verify = new URL(link!);
    expect(verify.searchParams.get("errorCallbackURL")).toBe("https://uploads.sh/auth/error");
    expect(verify.searchParams.get("callbackURL")).toBe("https://uploads.sh/account");

    verify.searchParams.set("token", "not-a-real-token");
    const failed = await app.request(
      verify.toString(),
      { headers: { origin: "https://uploads.sh" } },
      env,
    );
    expect(failed.status).toBe(302);
    const location = failed.headers.get("location") ?? "";
    expect(location.startsWith("https://uploads.sh/auth/error")).toBe(true);
    expect(location).toContain("error=INVALID_TOKEN");
    expect(location).not.toContain("/account");
  });
});
