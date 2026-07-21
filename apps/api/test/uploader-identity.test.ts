import { describe, expect, it } from "vitest";
import { hasGithubTags, uploaderTags } from "../src/uploader-identity";
import { GITHUB_APP_CFG_ENV } from "./github-app-env";

/** Minimal env: in-memory KV, stubbable AUTH, no GitHub App config. */
function makeEnv(opts: { accountId?: string | null; authStatus?: number } = {}) {
  const kv = new Map<string, string>();
  const authCalls: string[] = [];
  const env = {
    GITHUB_CACHE: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => {
        kv.set(key, value);
      },
    },
    AUTH: {
      fetch: async (url: string) => {
        authCalls.push(url);
        if (opts.authStatus) return new Response("nope", { status: opts.authStatus });
        return new Response(JSON.stringify({ githubAccountId: opts.accountId ?? null }), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  } as unknown as Env;
  return { env, kv, authCalls };
}

function githubFetch(login: string | null, status = 200): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.startsWith("https://api.github.com/user/")) {
      throw new Error(`unexpected fetch: ${url}`);
    }
    if (status !== 200) return new Response("err", { status });
    return new Response(JSON.stringify({ login }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("uploaderTags", () => {
  it("returns null with no minting user (legacy/enrollment tokens)", async () => {
    const { env } = makeEnv();
    await expect(uploaderTags(env, null)).resolves.toBeNull();
  });

  it("resolves account id → login and caches it", async () => {
    const { env, kv, authCalls } = makeEnv({ accountId: "583231" });
    const tags = await uploaderTags(env, "user-1", undefined, githubFetch("octocat"));
    expect(tags).toEqual({ "gh.uploader-id": "user-1", "gh.uploader": "octocat" });
    expect(kv.get("ghlogin:user-1")).toBe("octocat");
    // Second call is served from KV — no further AUTH round-trip.
    const again = await uploaderTags(env, "user-1", undefined, githubFetch("changed"));
    expect(again?.["gh.uploader"]).toBe("octocat");
    expect(authCalls).toHaveLength(1);
  });

  it("degrades to id-only when no GitHub account is linked, and caches the miss", async () => {
    const { env, authCalls } = makeEnv({ accountId: null });
    const tags = await uploaderTags(env, "user-1", undefined, githubFetch("never-called"));
    expect(tags).toEqual({ "gh.uploader-id": "user-1" });
    // Cached negative: the next call skips the AUTH lookup too.
    await uploaderTags(env, "user-1", undefined, githubFetch("never-called"));
    expect(authCalls).toHaveLength(1);
  });

  it("degrades to id-only when the GitHub user lookup fails", async () => {
    const { env } = makeEnv({ accountId: "583231" });
    const tags = await uploaderTags(env, "user-1", undefined, githubFetch(null, 500));
    expect(tags).toEqual({ "gh.uploader-id": "user-1" });
  });

  it("degrades to id-only on an auth-worker error", async () => {
    const { env } = makeEnv({ authStatus: 503 });
    const tags = await uploaderTags(env, "user-1", undefined, githubFetch("never-called"));
    expect(tags).toEqual({ "gh.uploader-id": "user-1" });
  });

  // Regression (found live): GitHub rejects App JWTs on /user/:id — only /app/*
  // endpoints accept them — so the App-configured path must send an
  // installation token (or nothing), never a JWT.
  it("authenticates /user/:id with an installation token from the tagged repo", async () => {
    const { env, kv } = makeEnv({ accountId: "583231" });
    Object.assign(env, GITHUB_APP_CFG_ENV);
    // Pre-seed the installation caches so no App JWT is ever minted.
    kv.set("ghinst:acme/site", "42");
    kv.set("ghtok:42", "ghs_install_token");
    let authHeader: string | null | undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      authHeader = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ login: "octocat" }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const tags = await uploaderTags(env, "user-1", "acme/site", fetchImpl);
    expect(tags?.["gh.uploader"]).toBe("octocat");
    expect(authHeader).toBe("Bearer ghs_install_token");
  });

  it("sends no auth header (not an App JWT) when no repo is in play", async () => {
    const { env } = makeEnv({ accountId: "583231" });
    Object.assign(env, GITHUB_APP_CFG_ENV);
    let authHeader: string | null | undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      authHeader = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ login: "octocat" }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const tags = await uploaderTags(env, "user-1", undefined, fetchImpl);
    expect(tags?.["gh.uploader"]).toBe("octocat");
    expect(authHeader).toBeNull();
  });

  it("never interpolates a non-numeric account id into the GitHub URL", async () => {
    const { env } = makeEnv({ accountId: "../evil" });
    const tags = await uploaderTags(env, "user-1", undefined, githubFetch("never-called"));
    expect(tags).toEqual({ "gh.uploader-id": "user-1" });
  });
});

describe("hasGithubTags", () => {
  it("detects gh.-prefixed keys and nothing else", () => {
    expect(hasGithubTags({ "gh.repo": "a/b" })).toBe(true);
    expect(hasGithubTags({ page: "onboarding" })).toBe(false);
    expect(hasGithubTags({})).toBe(false);
  });
});
