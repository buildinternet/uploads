import { describe, expect, it } from "vitest";
import { resolveTitles } from "./github-titles";
import { FakeKv } from "../test/fake-kv";
import { GITHUB_APP_CFG_ENV as CFG_ENV } from "../test/github-app-env";

function envWith(kv: FakeKv): Env {
  return { ...CFG_ENV, GITHUB_CACHE: kv } as unknown as Env;
}

/** Seed the home installation token so tests exercise the issue fetch only. */
function seedHomeToken(kv: FakeKv): void {
  kv.store.set("ghtok:777", { value: "ghs_home" });
}

const issueJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ title: "Fix the thing", state: "open", ...over });

describe("resolveTitles", () => {
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
    const out = await resolveTitles(envWith(kv), ["o/r#9"], fetchImpl);
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
    const out = await resolveTitles(envWith(kv), ["o/r#9"], fetchImpl);
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
    const out = await resolveTitles(envWith(kv), ["o/r#9"], fetchImpl);
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
    const out = await resolveTitles(envWith(kv), ["o/r#9"], fetchImpl);
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
    const out = await resolveTitles(envWith(kv), ["o/priv#1"], fetchImpl);
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
    const out = await resolveTitles(envWith(kv), ["o/priv#1"], fetchImpl);
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
    const out = await resolveTitles(envWith(kv), ["o/r#9"], fetchImpl);
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
    const out = await resolveTitles({ GITHUB_CACHE: kv } as unknown as Env, ["o/r#9"], fetchImpl);
    expect(out["o/r#9"]).toBeNull();
    expect(kv.store.size).toBe(0);
  });
});
