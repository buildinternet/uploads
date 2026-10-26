import { describe, expect, it } from "vitest";
import { bumpPublicTitleEpoch, resolveTitles, type TitleAudience } from "./github-titles";
import { FakeKv } from "../test/fake-kv";
import { GITHUB_APP_CFG_ENV as CFG_ENV } from "../test/github-app-env";

function envWith(kv: FakeKv): Env {
  return { ...CFG_ENV, GITHUB_CACHE: kv } as unknown as Env;
}

/** Seed the home installation token so tests exercise the issue fetch only. */
function seedHomeToken(kv: FakeKv): void {
  kv.store.set("ghtok:777", { value: "ghs_home" });
}

/** Member audience with the test repos linked, so the full ladder is exercised. */
const MEMBER: TitleAudience = { audience: "member", linkedRepos: new Set(["o/r", "o/priv"]) };
const PUBLIC: TitleAudience = { audience: "public" };

const issueJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ title: "Fix the thing", state: "open", ...over });

describe("resolveTitles (member audience, linked repo)", () => {
  it("resolves an open issue via the home token and caches it for 1h", async () => {
    const kv = new FakeKv();
    seedHomeToken(kv);
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.github.com/repos/o/r/issues/9");
      expect(((init?.headers ?? {}) as Record<string, string>).authorization).toBe(
        "Bearer ghs_home",
      );
      return new Response(issueJson(), { status: 200 });
    }) as typeof fetch;
    const out = await resolveTitles(envWith(kv), ["o/r#9"], MEMBER, fetchImpl);
    expect(out["o/r#9"]).toEqual({ title: "Fix the thing", state: "open", kind: "issue" });
    expect(kv.store.get("ghref:o/r#9")?.expirationTtl).toBe(3600);
  });

  it("marks merged PRs and caches closed/merged for 24h", async () => {
    const kv = new FakeKv();
    seedHomeToken(kv);
    const fetchImpl = (async () =>
      new Response(
        issueJson({ state: "closed", pull_request: { merged_at: "2026-07-01T00:00:00Z" } }),
        { status: 200 },
      )) as typeof fetch;
    const out = await resolveTitles(envWith(kv), ["o/r#9"], MEMBER, fetchImpl);
    expect(out["o/r#9"]).toEqual({ title: "Fix the thing", state: "merged", kind: "pull" });
    expect(kv.store.get("ghref:o/r#9")?.expirationTtl).toBe(86400);
  });

  it("serves the ref cache without any fetch", async () => {
    const kv = new FakeKv();
    kv.store.set("ghref:o/r#9", {
      value: JSON.stringify({ v: { title: "Cached", state: "open", kind: "issue" } }),
    });
    const fetchImpl = (async () => {
      throw new Error("must not fetch");
    }) as typeof fetch;
    const out = await resolveTitles(envWith(kv), ["o/r#9"], MEMBER, fetchImpl);
    expect(out["o/r#9"]).toEqual({ title: "Cached", state: "open", kind: "issue" });
  });

  it("falls back to the repo installation when the home token itself fails to mint", async () => {
    const kv = new FakeKv();
    // No ghtok:777 seeded and the dummy private key can't sign, so the home
    // mint fails; the cached repo installation must still be tried.
    kv.store.set("ghinst:o/r", { value: "4242" });
    kv.store.set("ghtok:4242", { value: "ghs_inst" });
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(((init?.headers ?? {}) as Record<string, string>).authorization).toBe(
        "Bearer ghs_inst",
      );
      return new Response(issueJson(), { status: 200 });
    }) as typeof fetch;
    const out = await resolveTitles(envWith(kv), ["o/r#9"], MEMBER, fetchImpl);
    expect(out["o/r#9"]).toEqual({ title: "Fix the thing", state: "open", kind: "issue" });
  });

  it("falls back to the repo's own installation on 404, then negative-caches a double miss", async () => {
    const kv = new FakeKv();
    seedHomeToken(kv);
    kv.store.set("ghinst:o/priv", { value: "4242" });
    kv.store.set("ghtok:4242", { value: "ghs_inst" });
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(((init?.headers ?? {}) as Record<string, string>).authorization);
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const out = await resolveTitles(envWith(kv), ["o/priv#1"], MEMBER, fetchImpl);
    expect(out["o/priv#1"]).toBeNull();
    expect(seen).toEqual(["Bearer ghs_home", "Bearer ghs_inst"]);
    expect(kv.store.get("ghref:o/priv#1")).toEqual({
      value: JSON.stringify({ v: null }),
      expirationTtl: 3600,
    });
  });

  it("skips the installation retry when the repo has none cached, and negative-caches", async () => {
    const kv = new FakeKv();
    seedHomeToken(kv);
    kv.store.set("ghinst:o/priv", { value: "none" });
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const out = await resolveTitles(envWith(kv), ["o/priv#1"], MEMBER, fetchImpl);
    expect(out["o/priv#1"]).toBeNull();
    expect(calls).toBe(1);
    expect(kv.store.get("ghref:o/priv#1")?.expirationTtl).toBe(3600);
  });

  it("extends the negative TTL to the rate-limit reset on 403", async () => {
    const kv = new FakeKv();
    seedHomeToken(kv);
    kv.store.set("ghinst:o/r", { value: "none" });
    const reset = String(Math.floor(Date.now() / 1000) + 7200);
    const fetchImpl = (async () =>
      new Response("", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset },
      })) as typeof fetch;
    const out = await resolveTitles(envWith(kv), ["o/r#9"], MEMBER, fetchImpl);
    expect(out["o/r#9"]).toBeNull();
    const ttl = kv.store.get("ghref:o/r#9")?.expirationTtl ?? 0;
    expect(ttl).toBeGreaterThan(3600);
    expect(ttl).toBeLessThanOrEqual(7260);
  });

  it("returns null per ref without caching when the App env is unset", async () => {
    const kv = new FakeKv();
    const fetchImpl = (async () => {
      throw new Error("must not fetch");
    }) as typeof fetch;
    const out = await resolveTitles(
      { GITHUB_CACHE: kv } as unknown as Env,
      ["o/r#9"],
      MEMBER,
      fetchImpl,
    );
    expect(out["o/r#9"]).toBeNull();
    expect(kv.store.size).toBe(0);
  });
});

describe("resolveTitles (public audience)", () => {
  /** Home token answers the issue fetch and the `/repos/:repo` visibility probe. */
  function homeFetch(isPrivate: boolean, seen: string[] = []): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(
        `${((init?.headers ?? {}) as Record<string, string>).authorization} ${String(input)}`,
      );
      return String(input).includes("/issues/")
        ? new Response(issueJson(), { status: 200 })
        : Response.json({ private: isPrivate });
    }) as typeof fetch;
  }

  it("resolves a verified-public repo via the home token into the ghref:pub: namespace", async () => {
    const kv = new FakeKv();
    seedHomeToken(kv);
    const out = await resolveTitles(envWith(kv), ["o/r#9"], PUBLIC, homeFetch(false));
    expect(out["o/r#9"]).toEqual({ title: "Fix the thing", state: "open", kind: "issue" });
    expect(kv.store.get("ghref:pub:o/r#9")?.expirationTtl).toBe(3600);
    expect(kv.store.has("ghref:o/r#9")).toBe(false);
  });

  it("negative-caches a private repo the home installation can read, without fetching the issue", async () => {
    const kv = new FakeKv();
    seedHomeToken(kv);
    const seen: string[] = [];
    const out = await resolveTitles(envWith(kv), ["o/r#9"], PUBLIC, homeFetch(true, seen));
    expect(out["o/r#9"]).toBeNull();
    expect(seen.some((line) => line.includes("/issues/"))).toBe(false);
    expect(kv.store.get("ghref:pub:o/r#9")).toEqual({
      value: JSON.stringify({ v: null }),
      expirationTtl: 3600,
    });
  });

  it("never walks to the repo's own installation", async () => {
    const kv = new FakeKv();
    seedHomeToken(kv);
    kv.store.set("ghinst:o/priv", { value: "4242" });
    kv.store.set("ghtok:4242", { value: "ghs_inst" });
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(((init?.headers ?? {}) as Record<string, string>).authorization);
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const out = await resolveTitles(envWith(kv), ["o/priv#1"], PUBLIC, fetchImpl);
    expect(out["o/priv#1"]).toBeNull();
    expect(seen).not.toContain("Bearer ghs_inst");
  });

  it("ignores member-namespace cache entries", async () => {
    const kv = new FakeKv();
    kv.store.set("ghref:o/priv#1", {
      value: JSON.stringify({ v: { title: "Secret", state: "open", kind: "pull" } }),
    });
    const out = await resolveTitles({ GITHUB_CACHE: kv } as unknown as Env, ["o/priv#1"], PUBLIC);
    expect(out["o/priv#1"]).toBeNull();
  });

  it("shares one visibility probe across refs in the same repo", async () => {
    const kv = new FakeKv();
    seedHomeToken(kv);
    const seen: string[] = [];
    await resolveTitles(envWith(kv), ["o/r#1", "o/r#2", "o/r#3"], PUBLIC, homeFetch(false, seen));
    expect(seen.filter((line) => line.endsWith("/repos/o/r"))).toHaveLength(1);
  });

  it("member audience uses the public ladder for repos not linked to the workspace", async () => {
    const kv = new FakeKv();
    seedHomeToken(kv);
    kv.store.set("ghinst:x/priv", { value: "4242" });
    kv.store.set("ghtok:4242", { value: "ghs_inst" });
    const seen: string[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(((init?.headers ?? {}) as Record<string, string>).authorization);
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const out = await resolveTitles(envWith(kv), ["x/priv#1"], MEMBER, fetchImpl);
    expect(out["x/priv#1"]).toBeNull();
    expect(seen).not.toContain("Bearer ghs_inst");
    expect(kv.store.has("ghref:pub:x/priv#1")).toBe(true);
    expect(kv.store.has("ghref:x/priv#1")).toBe(false);
  });
});

describe("resolveTitles (public epoch, issue #1066)", () => {
  const CACHED = { title: "Cached", state: "closed", kind: "pull" } as const;
  const noFetch = (async () => {
    throw new Error("must not fetch");
  }) as typeof fetch;

  it("serves an unstamped entry while the repo has no epoch (entries from before the epoch existed)", async () => {
    const kv = new FakeKv();
    kv.store.set("ghref:pub:o/r#9", { value: JSON.stringify({ v: CACHED }) });
    const out = await resolveTitles(envWith(kv), ["o/r#9"], PUBLIC, noFetch);
    expect(out["o/r#9"]).toEqual(CACHED);
  });

  it("treats unstamped and older-epoch entries as misses once the epoch is bumped", async () => {
    const kv = new FakeKv();
    seedHomeToken(kv);
    kv.store.set("ghpriv:o/r", { value: "1" });
    kv.store.set("ghref:pub:o/r#1", { value: JSON.stringify({ v: CACHED }) });
    kv.store.set("ghref:pub:o/r#2", { value: JSON.stringify({ v: CACHED, e: "1" }) });
    await bumpPublicTitleEpoch(envWith(kv), "o/r");
    const out = await resolveTitles(envWith(kv), ["o/r#1", "o/r#2"], PUBLIC, noFetch);
    expect(out).toEqual({ "o/r#1": null, "o/r#2": null });
  });

  it("stamps new entries with the current epoch so they are served on the next read", async () => {
    const kv = new FakeKv();
    seedHomeToken(kv);
    kv.store.set("ghpubgen:o/r", { value: "42" });
    let calls = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls++;
      return String(input).includes("/issues/")
        ? new Response(issueJson(), { status: 200 })
        : Response.json({ private: false });
    }) as typeof fetch;
    await resolveTitles(envWith(kv), ["o/r#9"], PUBLIC, fetchImpl);
    expect(JSON.parse(kv.store.get("ghref:pub:o/r#9")!.value)).toMatchObject({ e: "42" });
    const callsAfterFirst = calls;
    const again = await resolveTitles(envWith(kv), ["o/r#9"], PUBLIC, fetchImpl);
    expect(again["o/r#9"]?.title).toBe("Fix the thing");
    expect(calls).toBe(callsAfterFirst);
  });

  it("keeps the stored shape unchanged when the repo has no epoch", async () => {
    const kv = new FakeKv();
    seedHomeToken(kv);
    kv.store.set("ghpriv:o/r", { value: "1" });
    await resolveTitles(envWith(kv), ["o/r#9"], PUBLIC, noFetch);
    expect(kv.store.get("ghref:pub:o/r#9")?.value).toBe(JSON.stringify({ v: null }));
  });

  it("gives the epoch a TTL that outlives every entry written before the bump", async () => {
    const kv = new FakeKv();
    await bumpPublicTitleEpoch(envWith(kv), "o/r");
    expect(kv.store.get("ghpubgen:o/r")?.expirationTtl).toBeGreaterThan(86400);
  });

  it("reads the epoch once per repo per batch", async () => {
    const kv = new FakeKv();
    for (const n of [1, 2, 3]) {
      kv.store.set(`ghref:pub:o/r#${n}`, { value: JSON.stringify({ v: CACHED }) });
    }
    const reads: string[] = [];
    const get = kv.get.bind(kv);
    kv.get = async (key: string, type?: Parameters<FakeKv["get"]>[1]) => {
      reads.push(key);
      return get(key, type);
    };
    await resolveTitles(envWith(kv), ["o/r#1", "o/r#2", "o/r#3"], PUBLIC, noFetch);
    expect(reads.filter((k) => k === "ghpubgen:o/r")).toHaveLength(1);
  });

  it("fails closed when the epoch cannot be read", async () => {
    const kv = new FakeKv();
    kv.store.set("ghref:pub:o/r#9", { value: JSON.stringify({ v: CACHED }) });
    const get = kv.get.bind(kv);
    kv.get = async (key: string, type?: Parameters<FakeKv["get"]>[1]) => {
      if (key.startsWith("ghpubgen:")) throw new Error("kv down");
      return get(key, type);
    };
    const out = await resolveTitles(envWith(kv), ["o/r#9"], PUBLIC, noFetch);
    expect(out["o/r#9"]).toBeNull();
  });

  it("does not affect the member ladder", async () => {
    const kv = new FakeKv();
    kv.store.set("ghref:o/r#9", { value: JSON.stringify({ v: CACHED }) });
    await bumpPublicTitleEpoch(envWith(kv), "o/r");
    const out = await resolveTitles(envWith(kv), ["o/r#9"], MEMBER, noFetch);
    expect(out["o/r#9"]).toEqual(CACHED);
  });
});
