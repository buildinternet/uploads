/**
 * Canonical dual-auth usage vertical (issue #613 phase 2):
 * `/v1/workspaces/:workspace/usage*`. Exercised through the real composed
 * `app` (index.ts) — same style as `routes-workspace-files.test.ts` (phase
 * 1). Bearer-only coverage for the pre-existing `/v1/:workspace/usage*`
 * handlers stays in `test/routes-usage.test.ts`; this file is scoped to the
 * canonical surface: both credential types reaching the read snapshot, the
 * session-403 posture on the maintenance ops, and the `/me` alias forward.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/index";
import { sha256Hex, type WorkspaceRecord } from "../src/workspace";
import { FakeR2Bucket } from "./fake-r2";
import { UsageFakeD1 } from "./usage-fake-d1";

const TOKEN = "canonical-usage-token";
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
  opts: { member?: boolean; session?: boolean; getSessionCalls?: { count: number } } = {},
): Promise<{ env: Parameters<typeof app.request>[2]; db: UsageFakeD1 }> {
  const { member = true, session = true, getSessionCalls } = opts;
  const record: WorkspaceRecord = {
    provider: "r2",
    bucket: "uploads-default",
    binding: "UPLOADS_DEFAULT",
    prefix: "acme/",
    publicBaseUrl: "https://storage.uploads.sh",
    tokenHash: await sha256Hex(TOKEN),
  };
  const db = new UsageFakeD1();
  const env = {
    REGISTRY: {
      get: async (key: string) => (key === "ws:acme" ? record : null),
    },
    UPLOADS_DEFAULT: new FakeR2Bucket(),
    DB: db,
    WRITE_LIMITER: { limit: async () => ({ success: true }) },
    WEB_ORIGIN: "https://uploads.sh",
    AUTH: {
      fetch: async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.pathname === "/api/auth/get-session") {
          if (getSessionCalls) getSessionCalls.count++;
          return session ? Response.json({ session: {}, user: USER }) : Response.json(null);
        }
        if (url.pathname === "/internal/memberships") {
          return Response.json(
            member
              ? [
                  {
                    organizationId: "org-1",
                    organizationSlug: "acme",
                    organizationName: "Acme",
                    role: "member",
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
  return { env: env as unknown as Parameters<typeof app.request>[2], db };
}

describe("GET /v1/workspaces/:workspace/usage (dual auth)", () => {
  it("accepts a bearer token and includes scopes + plan", async () => {
    const { env } = await makeEnv();
    const res = await app.request(
      "/v1/workspaces/acme/usage",
      { headers: { Authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspace: string; scopes: string[]; plan: string };
    expect(body.workspace).toBe("acme");
    expect(body.plan).toBe("free");
    expect(body.scopes).toEqual(expect.arrayContaining(["files:read", "files:write"]));
  });

  it("accepts a session cookie for a member workspace, granting every FILE_SCOPES", async () => {
    const { env } = await makeEnv();
    const res = await app.request(
      "/v1/workspaces/acme/usage",
      { headers: { cookie: "session=x" } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspace: string; scopes: string[] };
    expect(body.workspace).toBe("acme");
    expect(body.scopes).toEqual(
      expect.arrayContaining(["files:read", "files:write", "files:delete"]),
    );
  });

  it("404s a signed-in caller who isn't a member of the workspace", async () => {
    const { env } = await makeEnv({ member: false });
    const res = await app.request(
      "/v1/workspaces/acme/usage",
      { headers: { cookie: "session=x" } },
      env,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("workspace_not_found");
  });

  it("401s with neither a bearer token nor a session cookie", async () => {
    const { env } = await makeEnv({ session: false });
    const res = await app.request("/v1/workspaces/acme/usage", {}, env);
    expect(res.status).toBe(401);
  });
});

describe("POST /v1/workspaces/:workspace/usage/reconcile and /purge-expired (token-only)", () => {
  it("bearer: reconcile succeeds", async () => {
    const { env } = await makeEnv();
    const res = await app.request(
      "/v1/workspaces/acme/usage/reconcile",
      { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { usage: { bytes: number } };
    expect(body.usage).toBeDefined();
  });

  it("session: reconcile 403s with a clear error even for a member", async () => {
    const { env } = await makeEnv();
    const res = await app.request(
      "/v1/workspaces/acme/usage/reconcile",
      { method: "POST", headers: { cookie: "session=x" } },
      env,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("usage_requires_token");
  });

  it("session: purge-expired 403s with a clear error even for a member", async () => {
    const { env } = await makeEnv();
    const res = await app.request(
      "/v1/workspaces/acme/usage/purge-expired",
      { method: "POST", headers: { cookie: "session=x" } },
      env,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("usage_requires_token");
  });

  it("non-member session still 404s before reaching the token gate (membership checked first)", async () => {
    const { env } = await makeEnv({ member: false });
    const res = await app.request(
      "/v1/workspaces/acme/usage/reconcile",
      { method: "POST", headers: { cookie: "session=x" } },
      env,
    );
    expect(res.status).toBe(404);
  });
});

describe("old-path alias forwards unchanged (issue #613 phase 2)", () => {
  it("/me/workspaces/:name/usage forwards to the canonical shape (superset: adds scopes + plan)", async () => {
    const { env } = await makeEnv();
    const canonical = await app.request(
      "/v1/workspaces/acme/usage",
      { headers: { cookie: "session=x" } },
      env,
    );
    const alias = await app.request(
      "/me/workspaces/acme/usage",
      { headers: { cookie: "session=x" } },
      env,
    );
    expect(alias.status).toBe(200);
    // `updatedAt` is stamped fresh per call when no ledger row exists yet
    // (see `getWorkspaceUsage`'s no-row branch) — not a shape difference, so
    // it's excluded from the equality check.
    const { updatedAt: _canonicalUpdatedAt, ...canonicalRest } = (await canonical.json()) as Record<
      string,
      unknown
    >;
    const { updatedAt: _aliasUpdatedAt, ...aliasRest } = (await alias.json()) as Record<
      string,
      unknown
    >;
    expect(aliasRest).toEqual(canonicalRest);
  });

  it("resolves the session exactly once for a forwarded aliased request", async () => {
    const getSessionCalls = { count: 0 };
    const { env } = await makeEnv({ getSessionCalls });
    const res = await app.request(
      "/me/workspaces/acme/usage",
      { headers: { cookie: "session=x" } },
      env,
    );
    expect(res.status).toBe(200);
    expect(getSessionCalls.count).toBe(1);
  });

  it("membership rejection still applies to the forwarded alias (wrong workspace -> 404)", async () => {
    const { env } = await makeEnv({ member: false });
    const res = await app.request(
      "/me/workspaces/acme/usage",
      { headers: { cookie: "session=x" } },
      env,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("workspace_not_found");
  });

  it("/v1/:workspace/usage (bearer path) is untouched by the canonical mount", async () => {
    const { env } = await makeEnv();
    const res = await app.request(
      "/v1/acme/usage",
      { headers: { Authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspace: string };
    expect(body.workspace).toBe("acme");
  });
});
