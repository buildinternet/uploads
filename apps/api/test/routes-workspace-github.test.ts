/**
 * Canonical dual-auth github vertical (issue #613 phase 3):
 * `/v1/workspaces/:workspace/github/*`. Exercised through the real composed
 * `app` (index.ts) — same style as `routes-workspace-usage.test.ts` (phase
 * 2). Bearer-only coverage for the pre-existing `/v1/:workspace/github/*`
 * sub-routers stays in `src/routes/github-*-route.test.ts`; this file is
 * scoped to the canonical surface: both credential types reaching the
 * handlers, the token-only posture on comment/promote, the session-admin-tier
 * posture on link/repo-link/health/activity, and untouched old-path behavior.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/index";
import { sha256Hex, type WorkspaceRecord } from "../src/workspace";
import { FakeKv } from "./fake-kv";
import { FakeR2Bucket } from "./fake-r2";
import { GITHUB_APP_CFG_ENV } from "./github-app-env";
import { withMintingUserToken } from "./helpers/fake-minting-user-token";
import { UsageFakeD1 } from "./usage-fake-d1";

const WS = "acme";
const TOKEN = "canonical-github-token";
const USER = { id: "u-1", email: "member@example.com", name: "Member" };

beforeAll(() => {
  if (!(crypto.subtle as SubtleCrypto & { timingSafeEqual?: unknown }).timingSafeEqual) {
    Object.defineProperty(crypto.subtle, "timingSafeEqual", {
      value: (left: ArrayBufferView, right: ArrayBufferView) => {
        const a = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
        const b = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
        if (a.length !== b.length) return false;
        let difference = 0;
        for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
        return difference === 0;
      },
    });
  }
});

async function makeEnv(
  opts: {
    member?: boolean;
    session?: boolean;
    role?: string;
    /** Layers a D1-scoped token on `TOKEN`'s hash, less than the legacy path's full grant. */
    scopedTokenScopes?: string[];
  } = {},
): Promise<{ env: Parameters<typeof app.request>[2]; db: UsageFakeD1; githubCache: FakeKv }> {
  const { member = true, session = true, role = "member" } = opts;
  const record: WorkspaceRecord = {
    provider: "r2",
    bucket: "b",
    binding: "UPLOADS_DEFAULT",
    prefix: "acme/",
    publicBaseUrl: "https://storage.uploads.sh",
    tokens: [{ hash: await sha256Hex(TOKEN), createdAt: new Date().toISOString() }],
  };
  const db = new UsageFakeD1();
  if (opts.scopedTokenScopes) {
    withMintingUserToken(db, {
      workspace: WS,
      tokenHash: await sha256Hex(TOKEN),
      mintingUserId: "minting-1",
      scopes: opts.scopedTokenScopes,
    });
  }
  const githubCache = new FakeKv();
  const env = {
    REGISTRY: {
      get: async (key: string) => (key === `ws:${WS}` ? record : null),
    },
    UPLOADS_DEFAULT: new FakeR2Bucket(),
    GITHUB_CACHE: githubCache,
    DB: db,
    WRITE_LIMITER: { limit: async () => ({ success: true }) },
    ...GITHUB_APP_CFG_ENV,
    AUTH: {
      fetch: async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.pathname === "/api/auth/get-session") {
          return session ? Response.json({ session: {}, user: USER }) : Response.json(null);
        }
        if (url.pathname === "/internal/memberships") {
          return Response.json(
            member
              ? [
                  {
                    organizationId: "org-1",
                    organizationSlug: WS,
                    organizationName: "Acme",
                    role,
                  },
                ]
              : [],
          );
        }
        return new Response(JSON.stringify({ githubAccountId: null }), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  };
  return { env: env as unknown as Parameters<typeof app.request>[2], db, githubCache };
}

function bearer(token = TOKEN) {
  return { Authorization: `Bearer ${token}` };
}
const sessionCookie = { cookie: "session=x" };

describe("POST /v1/workspaces/:workspace/github/comment (token-only)", () => {
  it("bearer with files:write reaches the handler", async () => {
    const { env, githubCache } = await makeEnv();
    githubCache.store.set("ghinst:acme/web", { value: "none" });
    const res = await app.request(
      "/v1/workspaces/acme/github/comment",
      {
        method: "POST",
        headers: { ...bearer(), "content-type": "application/json" },
        body: JSON.stringify({ repo: "acme/web", num: 1, kind: "pull" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ posted: false, reason: "not_installed" });
  });

  it("a files:read-only token 403s (canonical requires files:write, unlike the old path)", async () => {
    const { env } = await makeEnv({ scopedTokenScopes: ["files:read"] });
    const res = await app.request(
      "/v1/workspaces/acme/github/comment",
      {
        method: "POST",
        headers: { ...bearer(), "content-type": "application/json" },
        body: JSON.stringify({ repo: "acme/web", num: 1, kind: "pull" }),
      },
      env,
    );
    expect(res.status).toBe(403);
  });

  it("session member 403s with github_requires_token", async () => {
    const { env } = await makeEnv();
    const res = await app.request(
      "/v1/workspaces/acme/github/comment",
      {
        method: "POST",
        headers: { ...sessionCookie, "content-type": "application/json" },
        body: JSON.stringify({ repo: "acme/web", num: 1, kind: "pull" }),
      },
      env,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("github_requires_token");
  });

  it("non-member session 404s before reaching the token gate", async () => {
    const { env } = await makeEnv({ member: false });
    const res = await app.request(
      "/v1/workspaces/acme/github/comment",
      {
        method: "POST",
        headers: { ...sessionCookie, "content-type": "application/json" },
        body: JSON.stringify({ repo: "acme/web", num: 1, kind: "pull" }),
      },
      env,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("workspace_not_found");
  });
});

describe("old bearer path /v1/:workspace/github/comment is untouched (issue #613 phase 3)", () => {
  it("a files:read-only token still works (the old path's pre-existing, deliberately-unfixed scope)", async () => {
    const { env, githubCache } = await makeEnv({ scopedTokenScopes: ["files:read"] });
    githubCache.store.set("ghinst:acme/web", { value: "none" });
    const res = await app.request(
      "/v1/acme/github/comment",
      {
        method: "POST",
        headers: { ...bearer(), "content-type": "application/json" },
        body: JSON.stringify({ repo: "acme/web", num: 1, kind: "pull" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ posted: false, reason: "not_installed" });
  });
});

describe("POST /v1/workspaces/:workspace/github/promote (token-only)", () => {
  it("bearer with files:write reaches the handler", async () => {
    const { env } = await makeEnv();
    const res = await app.request(
      "/v1/workspaces/acme/github/promote",
      {
        method: "POST",
        headers: { ...bearer(), "content-type": "application/json" },
        body: JSON.stringify({ repo: "acme/web", num: 1, branch: "feat-x" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ promoted: [], skipped: [] });
  });

  it("a files:read-only token 403s (missing files:write)", async () => {
    const { env } = await makeEnv({ scopedTokenScopes: ["files:read"] });
    const res = await app.request(
      "/v1/workspaces/acme/github/promote",
      {
        method: "POST",
        headers: { ...bearer(), "content-type": "application/json" },
        body: JSON.stringify({ repo: "acme/web", num: 1, branch: "feat-x" }),
      },
      env,
    );
    expect(res.status).toBe(403);
  });

  it("session member 403s with github_requires_token", async () => {
    const { env } = await makeEnv();
    const res = await app.request(
      "/v1/workspaces/acme/github/promote",
      {
        method: "POST",
        headers: { ...sessionCookie, "content-type": "application/json" },
        body: JSON.stringify({ repo: "acme/web", num: 1, branch: "feat-x" }),
      },
      env,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("github_requires_token");
  });

  it("non-member session 404s before reaching the token gate", async () => {
    const { env } = await makeEnv({ member: false });
    const res = await app.request(
      "/v1/workspaces/acme/github/promote",
      {
        method: "POST",
        headers: { ...sessionCookie, "content-type": "application/json" },
        body: JSON.stringify({ repo: "acme/web", num: 1, branch: "feat-x" }),
      },
      env,
    );
    expect(res.status).toBe(404);
  });
});

describe("GET/POST/DELETE /v1/workspaces/:workspace/github/link (dual-auth, session-admin-gated)", () => {
  it("bearer with files:read reaches GET", async () => {
    const { env } = await makeEnv();
    const res = await app.request(
      "/v1/workspaces/acme/github/link?repo=acme%2Fweb",
      { headers: bearer() },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ repo: "acme/web", linked: false });
  });

  it("bearer missing files:read scope 403s", async () => {
    const { env } = await makeEnv({ scopedTokenScopes: ["files:write"] });
    const res = await app.request(
      "/v1/workspaces/acme/github/link?repo=acme%2Fweb",
      { headers: bearer() },
      env,
    );
    expect(res.status).toBe(403);
  });

  it("admin session 200s", async () => {
    const { env } = await makeEnv({ role: "admin" });
    const res = await app.request(
      "/v1/workspaces/acme/github/link?repo=acme%2Fweb",
      { headers: sessionCookie },
      env,
    );
    expect(res.status).toBe(200);
  });

  it("owner session 200s", async () => {
    const { env } = await makeEnv({ role: "owner" });
    const res = await app.request(
      "/v1/workspaces/acme/github/link?repo=acme%2Fweb",
      { headers: sessionCookie },
      env,
    );
    expect(res.status).toBe(200);
  });

  it("member (non-admin) session 403s with workspace_admin_required", async () => {
    const { env } = await makeEnv({ role: "member" });
    const res = await app.request(
      "/v1/workspaces/acme/github/link?repo=acme%2Fweb",
      { headers: sessionCookie },
      env,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("workspace_admin_required");
  });

  it("non-member session 404s (never reaches the admin-tier check)", async () => {
    const { env } = await makeEnv({ member: false });
    const res = await app.request(
      "/v1/workspaces/acme/github/link?repo=acme%2Fweb",
      { headers: sessionCookie },
      env,
    );
    expect(res.status).toBe(404);
  });

  it("GET /repo-link: admin session 200s, member session 403s", async () => {
    const admin = await makeEnv({ role: "admin" });
    const adminRes = await app.request(
      "/v1/workspaces/acme/github/repo-link?repo=acme%2Fweb",
      { headers: sessionCookie },
      admin.env,
    );
    expect(adminRes.status).toBe(200);
    expect(await adminRes.json()).toEqual({ binding: "none" });

    const member = await makeEnv({ role: "member" });
    const memberRes = await app.request(
      "/v1/workspaces/acme/github/repo-link?repo=acme%2Fweb",
      { headers: sessionCookie },
      member.env,
    );
    expect(memberRes.status).toBe(403);
  });

  it("POST link: admin session 200s, member session 403s", async () => {
    const admin = await makeEnv({ role: "admin" });
    const adminRes = await app.request(
      "/v1/workspaces/acme/github/link",
      {
        method: "POST",
        headers: { ...sessionCookie, "content-type": "application/json" },
        body: JSON.stringify({ repo: "acme/web" }),
      },
      admin.env,
    );
    expect(adminRes.status).toBe(200);

    const member = await makeEnv({ role: "member" });
    const memberRes = await app.request(
      "/v1/workspaces/acme/github/link",
      {
        method: "POST",
        headers: { ...sessionCookie, "content-type": "application/json" },
        body: JSON.stringify({ repo: "acme/web" }),
      },
      member.env,
    );
    expect(memberRes.status).toBe(403);
  });

  // Regression for CodeRabbit PR #617 review finding 3: `dualWorkspaceAuth`
  // used to hardcode `mintingUserId` to `null` on the session path, so
  // `isEntitledToClaimRepo` (which treats a null minting user as
  // "not entitled" by construction) always declined an admin session
  // caller's claim of an unbound repo — even one they're verifiably
  // entitled to. `mintingUserId` must carry the real session `userId`
  // (`USER.id`) so this entitlement check runs against the actual caller.
  it("claims an unbound repo for an entitled admin session caller (mintingUserId propagation)", async () => {
    const { env, githubCache, db } = await makeEnv({ role: "admin" });
    githubCache.store.set("ghinst:acme/web", { value: "42" });
    githubCache.store.set("ghtok:42", { value: "cached-token" });
    githubCache.store.set(`ghlogin:${USER.id}`, { value: "octocat" });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) =>
      String(url).includes("/collaborators/octocat/permission")
        ? new Response(JSON.stringify({ permission: "write" }), { status: 200 })
        : new Response("nf", { status: 404 })) as unknown as typeof fetch;
    try {
      const res = await app.request(
        "/v1/workspaces/acme/github/link",
        {
          method: "POST",
          headers: { ...sessionCookie, "content-type": "application/json" },
          body: JSON.stringify({ repo: "acme/web" }),
        },
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ claimed: true, workspace: WS, source: "cli" });
      expect(db.repoLinks.get("acme/web")).toMatchObject({ workspace_name: WS, source: "cli" });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("DELETE link: admin session 200s, member session 403s", async () => {
    const admin = await makeEnv({ role: "admin" });
    const adminRes = await app.request(
      "/v1/workspaces/acme/github/link?repo=acme%2Fweb",
      { method: "DELETE", headers: sessionCookie },
      admin.env,
    );
    expect(adminRes.status).toBe(200);

    const member = await makeEnv({ role: "member" });
    const memberRes = await app.request(
      "/v1/workspaces/acme/github/link?repo=acme%2Fweb",
      { method: "DELETE", headers: sessionCookie },
      member.env,
    );
    expect(memberRes.status).toBe(403);
  });
});

describe("GET /v1/workspaces/:workspace/github/health (dual-auth, session-admin-gated)", () => {
  it("bearer reaches the handler", async () => {
    const { env } = await makeEnv();
    const res = await app.request("/v1/workspaces/acme/github/health", { headers: bearer() }, env);
    expect(res.status).toBe(200);
  });

  it("admin session 200s", async () => {
    const { env } = await makeEnv({ role: "admin" });
    const res = await app.request(
      "/v1/workspaces/acme/github/health",
      { headers: sessionCookie },
      env,
    );
    expect(res.status).toBe(200);
  });

  it("member (non-admin) session 403s", async () => {
    const { env } = await makeEnv({ role: "member" });
    const res = await app.request(
      "/v1/workspaces/acme/github/health",
      { headers: sessionCookie },
      env,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("workspace_admin_required");
  });

  it("non-member session 404s", async () => {
    const { env } = await makeEnv({ member: false });
    const res = await app.request(
      "/v1/workspaces/acme/github/health",
      { headers: sessionCookie },
      env,
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/workspaces/:workspace/github/activity (dual-auth, session-admin-gated)", () => {
  it("bearer reaches the handler", async () => {
    const { env } = await makeEnv();
    const res = await app.request(
      "/v1/workspaces/acme/github/activity",
      { headers: bearer() },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ workspace: "acme", activity: [] });
  });

  it("admin session 200s", async () => {
    const { env } = await makeEnv({ role: "admin" });
    const res = await app.request(
      "/v1/workspaces/acme/github/activity",
      { headers: sessionCookie },
      env,
    );
    expect(res.status).toBe(200);
  });

  it("member (non-admin) session 403s", async () => {
    const { env } = await makeEnv({ role: "member" });
    const res = await app.request(
      "/v1/workspaces/acme/github/activity",
      { headers: sessionCookie },
      env,
    );
    expect(res.status).toBe(403);
  });

  it("non-member session 404s", async () => {
    const { env } = await makeEnv({ member: false });
    const res = await app.request(
      "/v1/workspaces/acme/github/activity",
      { headers: sessionCookie },
      env,
    );
    expect(res.status).toBe(404);
  });
});

describe("old-path bearer routes are untouched by the canonical mount (issue #613 phase 3)", () => {
  it("/v1/:workspace/github/link", async () => {
    const { env } = await makeEnv();
    const res = await app.request(
      "/v1/acme/github/link?repo=acme%2Fweb",
      { headers: bearer() },
      env,
    );
    expect(res.status).toBe(200);
  });

  it("/v1/:workspace/github/health", async () => {
    const { env } = await makeEnv();
    const res = await app.request("/v1/acme/github/health", { headers: bearer() }, env);
    expect(res.status).toBe(200);
  });

  it("/v1/:workspace/github/activity", async () => {
    const { env } = await makeEnv();
    const res = await app.request("/v1/acme/github/activity", { headers: bearer() }, env);
    expect(res.status).toBe(200);
  });
});
