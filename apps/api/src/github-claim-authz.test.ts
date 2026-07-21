import { describe, expect, it } from "vitest";
import { isEntitledToClaimRepo } from "./github-claim-authz";
import { FakeKv } from "../test/fake-kv";
import { GITHUB_APP_CFG_ENV } from "../test/github-app-env";

const REPO = "orgB/repo";

function baseEnv(githubCache: FakeKv, authResponse?: unknown): Env {
  return {
    GITHUB_CACHE: githubCache,
    AUTH: {
      fetch: async () =>
        authResponse === undefined
          ? new Response("nf", { status: 404 })
          : new Response(JSON.stringify(authResponse), { status: 200 }),
    },
    ...GITHUB_APP_CFG_ENV,
  } as unknown as Env;
}

function mockFetch(handlers: Record<string, () => Response>): typeof fetch {
  return (async (url: string) => {
    for (const [needle, respond] of Object.entries(handlers)) {
      if (String(url).includes(needle)) return respond();
    }
    return new Response("nf", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("isEntitledToClaimRepo (issue #297)", () => {
  it("is never entitled with no minting user (legacy/shared token)", async () => {
    const env = baseEnv(new FakeKv());
    const entitled = await isEntitledToClaimRepo(env, REPO, null);
    expect(entitled).toBe(false);
  });

  it("is never entitled when the GitHub App isn't configured", async () => {
    const env = {
      GITHUB_CACHE: new FakeKv(),
      AUTH: { fetch: async () => new Response("nf", { status: 404 }) },
      // No GITHUB_APP_ID/PRIVATE_KEY/HOME_INSTALLATION_ID.
    } as unknown as Env;
    const entitled = await isEntitledToClaimRepo(env, REPO, "user-1");
    expect(entitled).toBe(false);
  });

  it("is never entitled when the App isn't installed on the repo", async () => {
    const githubCache = new FakeKv();
    githubCache.store.set("ghinst:orgB/repo", { value: "none" });
    const env = baseEnv(githubCache);
    const entitled = await isEntitledToClaimRepo(env, REPO, "user-1");
    expect(entitled).toBe(false);
  });

  it("is entitled when the caller's linked GitHub login has write permission", async () => {
    const githubCache = new FakeKv();
    githubCache.store.set("ghinst:orgB/repo", { value: "42" });
    githubCache.store.set("ghtok:42", { value: "cached-token" });
    githubCache.store.set("ghlogin:user-1", { value: "octocat" });
    const env = baseEnv(githubCache);
    const fetchImpl = mockFetch({
      "/collaborators/octocat/permission": () =>
        new Response(JSON.stringify({ permission: "write" }), { status: 200 }),
    });
    const entitled = await isEntitledToClaimRepo(env, REPO, "user-1", fetchImpl);
    expect(entitled).toBe(true);
  });

  it.each(["admin", "maintain"])("treats %s permission as entitled", async (permission) => {
    const githubCache = new FakeKv();
    githubCache.store.set("ghinst:orgB/repo", { value: "42" });
    githubCache.store.set("ghtok:42", { value: "cached-token" });
    githubCache.store.set("ghlogin:user-1", { value: "octocat" });
    const env = baseEnv(githubCache);
    const fetchImpl = mockFetch({
      "/collaborators/octocat/permission": () =>
        new Response(JSON.stringify({ permission }), { status: 200 }),
    });
    expect(await isEntitledToClaimRepo(env, REPO, "user-1", fetchImpl)).toBe(true);
  });

  it.each(["read", "triage", "none"])(
    "does not treat %s permission as entitled",
    async (permission) => {
      const githubCache = new FakeKv();
      githubCache.store.set("ghinst:orgB/repo", { value: "42" });
      githubCache.store.set("ghtok:42", { value: "cached-token" });
      githubCache.store.set("ghlogin:user-1", { value: "octocat" });
      const env = baseEnv(githubCache);
      const fetchImpl = mockFetch({
        "/collaborators/octocat/permission": () =>
          new Response(JSON.stringify({ permission }), { status: 200 }),
      });
      expect(await isEntitledToClaimRepo(env, REPO, "user-1", fetchImpl)).toBe(false);
    },
  );

  it("is not entitled when the caller has no linked GitHub account", async () => {
    const githubCache = new FakeKv();
    githubCache.store.set("ghinst:orgB/repo", { value: "42" });
    githubCache.store.set("ghtok:42", { value: "cached-token" });
    // No ghlogin cache entry, and the AUTH lookup reports no linked account.
    const env = baseEnv(githubCache, { githubAccountId: null });
    const entitled = await isEntitledToClaimRepo(env, REPO, "user-1");
    expect(entitled).toBe(false);
  });

  it("is not entitled when the collaborator-permission lookup fails", async () => {
    const githubCache = new FakeKv();
    githubCache.store.set("ghinst:orgB/repo", { value: "42" });
    githubCache.store.set("ghtok:42", { value: "cached-token" });
    githubCache.store.set("ghlogin:user-1", { value: "octocat" });
    const env = baseEnv(githubCache);
    // No handler for /collaborators/... — mockFetch's default 404 applies.
    const entitled = await isEntitledToClaimRepo(env, REPO, "user-1", mockFetch({}));
    expect(entitled).toBe(false);
  });

  it("reuses a caller-supplied installation id instead of re-resolving it", async () => {
    const githubCache = new FakeKv();
    // Deliberately no "ghinst:orgB/repo" cache entry — if the function called
    // installationForRepo anyway, it would have to hit the network (uncached)
    // and this test's fetch mock doesn't answer that endpoint.
    githubCache.store.set("ghtok:99", { value: "cached-token" });
    githubCache.store.set("ghlogin:user-1", { value: "octocat" });
    const env = baseEnv(githubCache);
    const fetchImpl = mockFetch({
      "/collaborators/octocat/permission": () =>
        new Response(JSON.stringify({ permission: "write" }), { status: 200 }),
    });
    const entitled = await isEntitledToClaimRepo(env, REPO, "user-1", fetchImpl, 99);
    expect(entitled).toBe(true);
  });
});
