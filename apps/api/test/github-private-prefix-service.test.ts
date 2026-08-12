/**
 * Service-level matrix for `resolveGhKeyContext` (issue #631, Task 4) — the
 * decision flow behind `POST /v1/:workspace/github/private-prefix`. Route
 * coverage (auth, body validation, response shape) lives in
 * `routes/github-private-prefix.test.ts`; this file is scoped to the
 * fail-open decision flow itself.
 */
import { describe, expect, it } from "vitest";
import { GITHUB_APP_CFG_ENV } from "./github-app-env";
import { resolveGhKeyContext } from "../src/github-private-prefix-service";
import { recordRepoLink } from "../src/github-repo-links";
import { FakeKv } from "./fake-kv";
import { withGlobalFetch } from "./helpers/github-fetch-fakes";
import { UsageFakeD1 } from "./usage-fake-d1";

const WS = "acme";
const REPO = "acme/web";

function makeEnv(opts: { appConfigured?: boolean } = {}): {
  env: Env;
  db: UsageFakeD1;
  githubCache: FakeKv;
} {
  const db = new UsageFakeD1();
  const githubCache = new FakeKv();
  const env = {
    ...(opts.appConfigured === false ? {} : GITHUB_APP_CFG_ENV),
    GITHUB_CACHE: githubCache,
    DB: db,
  } as unknown as Env;
  return { env, db, githubCache };
}

function seedInstalled(githubCache: FakeKv, installId = 42) {
  githubCache.store.set(`ghinst:${REPO}`, { value: String(installId) });
}

function seedPrivacy(githubCache: FakeKv, isPrivate: boolean) {
  githubCache.store.set(`ghpriv:${REPO}`, { value: isPrivate ? "1" : "0" });
}

function seedHeadBranch(githubCache: FakeKv, num: number, branch: string) {
  githubCache.store.set(`prhead:${REPO}#${num}`, { value: branch });
}

async function bindTo(db: UsageFakeD1, workspace: string) {
  await recordRepoLink(db as unknown as D1Database, REPO, workspace, "test");
}

/**
 * Rebuilds `env.DB` so any SQL containing `matchSubstring` throws instead of
 * delegating to the fake — for exercising the fail-open guard around
 * `getOrMintPrefixId`'s D1 calls without a dedicated throwing-D1 fake.
 */
function withThrowingDb(env: Env, db: UsageFakeD1, matchSubstring: string): Env {
  return {
    ...env,
    DB: {
      prepare: (sql: string) => {
        if (sql.includes(matchSubstring)) throw new Error("simulated D1 failure");
        return db.prepare(sql);
      },
    },
  } as unknown as Env;
}

describe("resolveGhKeyContext", () => {
  it("App not configured → plain", async () => {
    const { env } = makeEnv({ appConfigured: false });
    await expect(
      resolveGhKeyContext(env, WS, "user-1", { repo: REPO, branch: "main" }),
    ).resolves.toEqual({ mode: "plain" });
  });

  it("no installation → plain", async () => {
    const { env } = makeEnv();
    // No `ghinst:` seed and no fetch stub → installationForRepo's network
    // call fails and degrades to null.
    const result = await withGlobalFetch(
      (async () => new Response("nf", { status: 404 })) as unknown as typeof fetch,
      () => resolveGhKeyContext(env, WS, "user-1", { repo: REPO, branch: "main" }),
    );
    expect(result).toEqual({ mode: "plain" });
  });

  it("public repo → plain", async () => {
    const { env, githubCache } = makeEnv();
    seedInstalled(githubCache);
    seedPrivacy(githubCache, false);
    await expect(
      resolveGhKeyContext(env, WS, "user-1", { repo: REPO, branch: "main" }),
    ).resolves.toEqual({ mode: "plain" });
  });

  it("private + authorized + explicit branch → private, stable id across calls", async () => {
    const { env, db, githubCache } = makeEnv();
    seedInstalled(githubCache);
    seedPrivacy(githubCache, true);
    await bindTo(db, WS);

    const first = await resolveGhKeyContext(env, WS, "user-1", { repo: REPO, branch: "feat-x" });
    const second = await resolveGhKeyContext(env, WS, "user-1", { repo: REPO, branch: "feat-x" });
    expect(first).toEqual({ mode: "private", prefixId: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(second).toEqual(first);
  });

  it("private + pull target → id of the mocked head branch (matches staging that branch directly)", async () => {
    const { env, db, githubCache } = makeEnv();
    seedInstalled(githubCache);
    seedPrivacy(githubCache, true);
    seedHeadBranch(githubCache, 7, "feat-y");
    await bindTo(db, WS);

    const viaTarget = await resolveGhKeyContext(env, WS, "user-1", {
      repo: REPO,
      target: { kind: "pull", num: 7 },
    });
    const viaBranch = await resolveGhKeyContext(env, WS, "user-1", {
      repo: REPO,
      branch: "feat-y",
    });
    expect(viaTarget).toEqual({ mode: "private", prefixId: expect.any(String) });
    expect(viaTarget).toEqual(viaBranch);
  });

  it("private + issues target → repo-level ('') id, distinct from a branch id", async () => {
    const { env, db, githubCache } = makeEnv();
    seedInstalled(githubCache);
    seedPrivacy(githubCache, true);
    await bindTo(db, WS);

    const issues = await resolveGhKeyContext(env, WS, "user-1", {
      repo: REPO,
      target: { kind: "issues", num: 3 },
    });
    const branch = await resolveGhKeyContext(env, WS, "user-1", { repo: REPO, branch: "main" });
    expect(issues).toMatchObject({ mode: "private" });
    expect(branch).toMatchObject({ mode: "private" });
    if (issues.mode === "private" && branch.mode === "private") {
      expect(issues.prefixId).not.toBe(branch.prefixId);
    }
  });

  it("unauthorized workspace → plain, and no row is minted (table untouched)", async () => {
    const { env, db, githubCache } = makeEnv();
    seedInstalled(githubCache);
    seedPrivacy(githubCache, true);
    // Repo unbound, mintingUserId null → isEntitledToClaimRepo declines.
    const result = await resolveGhKeyContext(env, WS, null, { repo: REPO, branch: "main" });
    expect(result).toEqual({ mode: "plain" });
    expect(db.privatePrefixes.size).toBe(0);
  });

  it("D1 failure minting the prefix row → plain (fail-open, never a thrown 500)", async () => {
    const { env, db, githubCache } = makeEnv();
    seedInstalled(githubCache);
    seedPrivacy(githubCache, true);
    await bindTo(db, WS);

    const throwingEnv = withThrowingDb(env, db, "github_private_prefixes");
    await expect(
      resolveGhKeyContext(throwingEnv, WS, "user-1", { repo: REPO, branch: "feat-z" }),
    ).resolves.toEqual({ mode: "plain" });
  });

  it("privacy lookup failure (null) → plain", async () => {
    const { env, githubCache } = makeEnv();
    seedInstalled(githubCache);
    // No `ghpriv:` seed and no reachable token/fetch → repoIsPrivate degrades to null.
    const result = await withGlobalFetch(
      (async () => new Response("nf", { status: 404 })) as unknown as typeof fetch,
      () => resolveGhKeyContext(env, WS, "user-1", { repo: REPO, branch: "main" }),
    );
    expect(result).toEqual({ mode: "plain" });
  });
});
