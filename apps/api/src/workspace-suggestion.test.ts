import { describe, expect, it } from "vitest";
import { slugFromGithubLogin, suggestWorkspaceName } from "./workspace-suggestion";

/**
 * `resolveUploaderLogin` short-circuits on a `ghlogin:<userId>` cache hit, so
 * seeding that key exercises the whole suggestion path with no GitHub or AUTH
 * round-trip. `login: null` instead leaves the cache empty and has AUTH report
 * no linked account — the real "nothing to suggest from" path, rather than
 * depending on the exact bytes of that module's private miss sentinel.
 */
function stubEnv(
  opts: { login?: string | null; taken?: Record<string, unknown> | string[] } = {},
): Env {
  const { login = "Octocat", taken = [] } = opts;
  // An array is shorthand for "occupied by an ordinary record"; an object maps
  // name → whatever blob sits at `ws:<name>`, so tests can seed a soft-deleted
  // record or a purged tombstone.
  const occupied: Record<string, unknown> = Array.isArray(taken)
    ? Object.fromEntries(taken.map((n) => [n, { provider: "r2", bucket: "b" }]))
    : taken;
  return {
    GITHUB_CACHE: {
      get: async (key: string) => (login !== null && key === "ghlogin:u-1" ? login : null),
      put: async () => {},
    },
    AUTH: {
      fetch: async () => Response.json({ githubAccountId: null }),
    },
    REGISTRY: {
      get: async (key: string) => {
        const name = key.startsWith("ws:") ? key.slice(3) : key;
        // Mirrors a raw `REGISTRY.get` with no type option: the stored blob if
        // the key exists, null otherwise. Occupancy is what matters, not shape.
        return name in occupied ? JSON.stringify(occupied[name]) : null;
      },
    },
  } as unknown as Env;
}

describe("slugFromGithubLogin", () => {
  it("lowercases a normal login", () => {
    expect(slugFromGithubLogin("Octocat")).toBe("octocat");
  });

  it("keeps internal hyphens", () => {
    expect(slugFromGithubLogin("build-internet")).toBe("build-internet");
  });

  it("trims leading and trailing hyphens so the slug starts alphanumeric", () => {
    expect(slugFromGithubLogin("-edge-")).toBe("edge");
  });

  it("collapses runs of hyphens", () => {
    expect(slugFromGithubLogin("a--b")).toBe("a-b");
  });

  // GitHub allows 1-character logins; our slugs require 2-63. Not representable.
  it("returns null for a 1-char login", () => {
    expect(slugFromGithubLogin("t")).toBeNull();
  });

  it("returns null when nothing survives normalization", () => {
    expect(slugFromGithubLogin("---")).toBeNull();
  });
});

describe("suggestWorkspaceName", () => {
  it("suggests the derived slug when it is valid and free", async () => {
    expect(await suggestWorkspaceName(stubEnv(), "u-1")).toBe("octocat");
  });

  it("offers nothing when no GitHub account is linked", async () => {
    expect(await suggestWorkspaceName(stubEnv({ login: null }), "u-1")).toBeNull();
  });

  it("offers nothing when the login is already a workspace", async () => {
    expect(await suggestWorkspaceName(stubEnv({ taken: ["octocat"] }), "u-1")).toBeNull();
  });

  // `loadWorkspaceRecord` hides these two, but they still hold the KV key and
  // `POST /v1/workspaces` still 409s on them — so suggesting one would prefill
  // a name that fails the moment the user submits it.
  it("offers nothing when the name is held by a soft-deleted workspace", async () => {
    const env = stubEnv({
      taken: { octocat: { provider: "r2", bucket: "b", deletedAt: "2026-07-01T00:00:00.000Z" } },
    });
    expect(await suggestWorkspaceName(env, "u-1")).toBeNull();
  });

  it("offers nothing when the name is held by a purged tombstone", async () => {
    const env = stubEnv({ taken: { octocat: { status: "purged" } } });
    expect(await suggestWorkspaceName(env, "u-1")).toBeNull();
  });

  it("offers nothing for a reserved name", async () => {
    // `admin` is a real GitHub login shape and a reserved slug.
    expect(await suggestWorkspaceName(stubEnv({ login: "admin" }), "u-1")).toBeNull();
  });

  it("offers nothing for a login that cannot become a valid slug", async () => {
    expect(await suggestWorkspaceName(stubEnv({ login: "t" }), "u-1")).toBeNull();
  });

  it("offers nothing rather than throwing when the login lookup fails", async () => {
    const env = {
      GITHUB_CACHE: {
        get: async () => {
          throw new Error("KV down");
        },
        put: async () => {},
      },
      REGISTRY: { get: async () => null },
    } as unknown as Env;
    expect(await suggestWorkspaceName(env, "u-1")).toBeNull();
  });
});
