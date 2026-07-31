import { describe, expect, it } from "vitest";
import { resolveUploaderAccountId } from "./uploader-identity";
import { FakeKv } from "../test/fake-kv";

/**
 * `resolveUploaderAccountId` (issue #297 control 2): Better Auth user →
 * numeric GitHub account id, KV-cached. The login-chain sibling
 * (`resolveUploaderLogin`) is exercised via the attribution tests; this
 * covers the id-only resolver's cache and degrade behavior.
 */
function envWith(kv: FakeKv, authResponse?: () => Response): Env {
  return {
    GITHUB_CACHE: kv,
    AUTH: {
      fetch: async () => {
        if (!authResponse) throw new Error("AUTH unavailable");
        return authResponse();
      },
    },
  } as unknown as Env;
}

describe("resolveUploaderAccountId", () => {
  it("resolves via AUTH and caches the numeric id", async () => {
    const kv = new FakeKv();
    const env = envWith(kv, () => Response.json({ githubAccountId: "12345" }));
    expect(await resolveUploaderAccountId(env, "user_1")).toBe(12345);
    expect(kv.store.get("ghacct:user_1")?.value).toBe("12345");
    // Cached — a second call must not hit AUTH (swap in a throwing env).
    expect(await resolveUploaderAccountId(envWith(kv), "user_1")).toBe(12345);
  });

  it("caches a no-linked-account miss and returns null", async () => {
    const kv = new FakeKv();
    const env = envWith(kv, () => new Response("nf", { status: 404 }));
    expect(await resolveUploaderAccountId(env, "user_1")).toBeNull();
    expect(kv.store.get("ghacct:user_1")?.value).toBe("\0none");
    expect(await resolveUploaderAccountId(envWith(kv), "user_1")).toBeNull();
  });

  it("returns null without caching when AUTH throws, and for a null user", async () => {
    const kv = new FakeKv();
    expect(await resolveUploaderAccountId(envWith(kv), "user_1")).toBeNull();
    expect(kv.store.size).toBe(0);
    expect(await resolveUploaderAccountId(envWith(kv), null)).toBeNull();
  });

  it("rejects a non-numeric account id", async () => {
    const kv = new FakeKv();
    const env = envWith(kv, () => Response.json({ githubAccountId: "not-a-number" }));
    expect(await resolveUploaderAccountId(env, "user_1")).toBeNull();
    expect(kv.store.get("ghacct:user_1")?.value).toBe("\0none");
  });

  it("rejects an id beyond Number.MAX_SAFE_INTEGER (would round on conversion)", async () => {
    const kv = new FakeKv();
    const env = envWith(kv, () => Response.json({ githubAccountId: "99999999999999999999" }));
    expect(await resolveUploaderAccountId(env, "user_1")).toBeNull();
    expect(kv.store.get("ghacct:user_1")?.value).toBe("\0none");
  });
});
