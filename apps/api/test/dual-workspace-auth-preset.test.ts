/**
 * Regression coverage for issue #613 phase 3 whole-branch review finding 2:
 * `requireSessionAdmin()` used to read `c.get("sessionUser")`, a var only a
 * real `sessionAuth` round trip ever sets — never the `presetResolvedSessionUser`
 * WeakMap fast path `dualWorkspaceAuth()` also supports. Composing
 * `dualWorkspaceAuth()` + `requireSessionAdmin()` (exactly the pattern
 * `routes/workspace-github.ts` uses, and the pattern the `requireSessionAdmin`
 * docblock explicitly invites other verticals to reuse) on a PRESET/forwarded
 * request used to 401 an already-authenticated caller. Exercised directly
 * against `workspaceGithub` (rather than through a `/me` forward) so the
 * preset can be set on the exact `Request` instance that reaches the guard,
 * same technique `routes/me.ts`'s `forwardTo*` helpers use in production.
 */
import { describe, expect, it } from "vitest";
import { presetResolvedSessionUser } from "../src/dual-workspace-auth";
import { workspaceGithub } from "../src/routes/workspace-github";
import { type WorkspaceRecord } from "../src/workspace";
import { FakeKv } from "./fake-kv";
import { FakeR2Bucket } from "./fake-r2";
import { GITHUB_APP_CFG_ENV } from "./github-app-env";
import { UsageFakeD1 } from "./usage-fake-d1";

const WS = "acme";
const USER_ID = "u-preset-1";

function makeEnv(
  opts: { role?: string; member?: boolean; getSessionCalls?: { count: number } } = {},
) {
  const { role = "admin", member = true, getSessionCalls } = opts;
  const record: WorkspaceRecord = {
    provider: "r2",
    bucket: "b",
    binding: "UPLOADS_DEFAULT",
    prefix: "acme/",
    publicBaseUrl: "https://storage.uploads.sh",
    tokens: [],
  };
  return {
    REGISTRY: { get: async (key: string) => (key === `ws:${WS}` ? record : null) },
    UPLOADS_DEFAULT: new FakeR2Bucket(),
    GITHUB_CACHE: new FakeKv(),
    DB: new UsageFakeD1(),
    WRITE_LIMITER: { limit: async () => ({ success: true }) },
    ...GITHUB_APP_CFG_ENV,
    AUTH: {
      fetch: async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.pathname === "/api/auth/get-session") {
          // A preset session must never fall back to a real get-session
          // round trip — see the "zero get-session calls" assertion below.
          if (getSessionCalls) getSessionCalls.count++;
          return Response.json({
            session: {},
            user: { id: USER_ID, email: "preset@example.com", name: "Preset" },
          });
        }
        if (url.pathname === "/internal/memberships") {
          return Response.json(
            member
              ? [{ organizationId: "org-1", organizationSlug: WS, organizationName: "Acme", role }]
              : [],
          );
        }
        return new Response(JSON.stringify({ githubAccountId: null }), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  } as unknown as Env;
}

describe("preset session + requireSessionAdmin composition (issue #613 phase 3 review finding 2)", () => {
  it("an admin session preset via presetResolvedSessionUser reaches the handler (no re-resolution)", async () => {
    const getSessionCalls = { count: 0 };
    const env = makeEnv({ role: "admin", getSessionCalls });
    const request = new Request("https://internal/acme/github/link?repo=acme%2Fweb");
    presetResolvedSessionUser(request, USER_ID);
    const res = await workspaceGithub.fetch(request, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ repo: "acme/web", linked: false });
    // Neither `dualWorkspaceAuth`'s session resolution nor `requireSessionAdmin`'s
    // role check should trigger a real `get-session` call for a preset request.
    expect(getSessionCalls.count).toBe(0);
  });

  it("a non-admin member session preset via presetResolvedSessionUser 403s workspace_admin_required", async () => {
    const env = makeEnv({ role: "member" });
    const request = new Request("https://internal/acme/github/link?repo=acme%2Fweb");
    presetResolvedSessionUser(request, USER_ID);
    const res = await workspaceGithub.fetch(request, env);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "workspace_admin_required",
    );
  });

  it("a non-member session preset via presetResolvedSessionUser 404s (dualWorkspaceAuth's own membership check)", async () => {
    const env = makeEnv({ member: false });
    const request = new Request("https://internal/acme/github/link?repo=acme%2Fweb");
    presetResolvedSessionUser(request, USER_ID);
    const res = await workspaceGithub.fetch(request, env);
    expect(res.status).toBe(404);
  });

  it("a direct (non-preset) admin session still works via the real sessionAuth round trip", async () => {
    const getSessionCalls = { count: 0 };
    const env = makeEnv({ role: "admin", getSessionCalls });
    const res = await workspaceGithub.fetch(
      new Request("https://internal/acme/github/link?repo=acme%2Fweb", {
        headers: { cookie: "session=x" },
      }),
      env,
    );
    expect(res.status).toBe(200);
    // Direct path still resolves the session exactly once — requireSessionAdmin
    // reads `sessionUserId` off the context rather than re-resolving.
    expect(getSessionCalls.count).toBe(1);
  });
});
