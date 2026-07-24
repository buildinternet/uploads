import { describe, expect, it } from "vitest";
import { FakeKv } from "../test/fake-kv";
import { GITHUB_APP_CFG_ENV as CFG_ENV } from "../test/github-app-env";
import { UsageFakeD1 } from "../test/usage-fake-d1";
import { recordRepoLink } from "./github-repo-links";
import { githubInstallStatus } from "./github-install-status";

function env(db: unknown, kv: FakeKv, cfg = CFG_ENV): Env {
  return { ...cfg, DB: db, GITHUB_CACHE: kv } as unknown as Env;
}

/** A fetch that fails the test if called — every case here is cache-served. */
const noFetch = (() => {
  throw new Error("unexpected GitHub call");
}) as unknown as typeof fetch;

describe("githubInstallStatus", () => {
  it("reports not-configured without touching D1", async () => {
    const db = {
      prepare: () => {
        throw new Error("unexpected D1 query");
      },
    };
    const status = await githubInstallStatus(env(db, new FakeKv(), {} as typeof CFG_ENV), "acme");
    expect(status).toEqual({ configured: false, installed: false, checkedRepos: 0 });
  });

  it("reports not-installed for a workspace with no bound repos", async () => {
    const status = await githubInstallStatus(
      env(new UsageFakeD1(), new FakeKv(), CFG_ENV),
      "acme",
      noFetch,
    );
    expect(status).toEqual({ configured: true, installed: false, checkedRepos: 0 });
  });

  it("reports installed when a bound repo has a cached installation", async () => {
    const db = new UsageFakeD1();
    await recordRepoLink(db as unknown as D1Database, "acme/web", "acme", "comment");
    const kv = new FakeKv();
    kv.store.set("ghinst:acme/web", { value: "42" });
    const status = await githubInstallStatus(env(db, kv, CFG_ENV), "acme", noFetch);
    expect(status).toEqual({ configured: true, installed: true, checkedRepos: 1 });
  });

  it("reports not-installed when every bound repo is cached as uninstalled", async () => {
    const db = new UsageFakeD1();
    await recordRepoLink(db as unknown as D1Database, "acme/web", "acme", "comment");
    await recordRepoLink(db as unknown as D1Database, "acme/api", "acme", "comment");
    const kv = new FakeKv();
    kv.store.set("ghinst:acme/web", { value: "none" });
    kv.store.set("ghinst:acme/api", { value: "none" });
    const status = await githubInstallStatus(env(db, kv, CFG_ENV), "acme", noFetch);
    expect(status).toEqual({ configured: true, installed: false, checkedRepos: 2 });
  });

  it("ignores repos bound to another workspace", async () => {
    const db = new UsageFakeD1();
    await recordRepoLink(db as unknown as D1Database, "other/web", "other", "comment");
    const kv = new FakeKv();
    kv.store.set("ghinst:other/web", { value: "42" });
    const status = await githubInstallStatus(env(db, kv, CFG_ENV), "acme", noFetch);
    expect(status).toEqual({ configured: true, installed: false, checkedRepos: 0 });
  });

  it("degrades to not-installed when the link lookup throws", async () => {
    const db = {
      prepare: () => ({
        bind: () => ({
          all: async () => {
            throw new Error("D1 unavailable");
          },
        }),
      }),
    };
    const status = await githubInstallStatus(env(db, new FakeKv(), CFG_ENV), "acme", noFetch);
    expect(status).toEqual({ configured: true, installed: false, checkedRepos: 0 });
  });
});
