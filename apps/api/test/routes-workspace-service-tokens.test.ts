/**
 * Workspace-owned service tokens (issue #1026):
 * `/v1/workspaces/:workspace/service-tokens*` through the composed `app`, the
 * bearer auth that resolves one, and the uploader attribution it produces.
 */
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { createToken, MAX_ACTIVE_SERVICE_TOKENS } from "../src/auth-db";
import { respondError } from "../src/error-response";
import { app } from "../src/index";
import { mintingUserIdOf, type UploaderIdentity, withUploaderTags } from "../src/uploader-identity";
import {
  isWorkspaceTokenShaped,
  uploaderIdentityOf,
  workspaceAuth,
  workspaceNameFromToken,
  type WorkspaceVars,
} from "../src/workspace";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const MIGRATIONS = [
  "migrations/20260710120000_auth.sql",
  "migrations/20260712230000_token_minting_user.sql",
  "migrations/20260817180000_token_last_used.sql",
  "migrations/20260925120000_workspace_service_tokens.sql",
];

beforeAll(() => {
  // workerd has crypto.subtle.timingSafeEqual; Node doesn't. workspaceAuth calls it.
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
      configurable: true,
    });
  }
});

const ADMIN = { id: "u-admin", email: "admin@example.com", name: "Admin" };

interface EnvOpts {
  role?: string;
  db?: SqliteD1;
}

function makeEnv(opts: EnvOpts = {}) {
  const { role = "admin", db = new SqliteD1(MIGRATIONS) } = opts;
  const AUTH = {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const url = new URL(req.url);
      if (url.pathname === "/api/auth/get-session") {
        return Response.json({ session: {}, user: ADMIN });
      }
      if (url.pathname === "/internal/memberships") {
        return Response.json([
          { organizationId: "org-1", organizationSlug: "acme", organizationName: "Acme", role },
        ]);
      }
      return new Response(null, { status: 404 });
    }) as Fetcher["fetch"],
  };
  const REGISTRY = {
    get: async () => ({ provider: "r2", bucket: "test", name: "acme" }),
    put: async () => undefined,
  };
  return { env: { AUTH, DB: database(db), REGISTRY } as unknown as Env, db };
}

const session = { cookie: "session=x", "content-type": "application/json" };

async function mint(env: Env, body: Record<string, unknown>) {
  return app.request(
    "/v1/workspaces/acme/service-tokens",
    { method: "POST", headers: session, body: JSON.stringify(body) },
    env,
  );
}

type ErrorBody = { error: { code: string } };

describe("POST /v1/workspaces/:workspace/service-tokens", () => {
  it("mints a workspace-owned token with no member owner and records the admin", async () => {
    const { env, db } = makeEnv();
    const res = await mint(env, { label: "CI", scopes: ["files:read", "files:write"] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.token).toMatch(/^ups_acme_/);
    expect(body.label).toBe("CI");
    expect(body.createdByUserId).toBe(ADMIN.id);
    expect(body.expiresAt).toEqual(expect.any(String));

    const row = await database(db)
      .prepare(`SELECT owner, minting_user_id, created_by_user_id FROM auth_tokens`)
      .first<Record<string, unknown>>();
    expect(row).toEqual({
      owner: "workspace",
      minting_user_id: null,
      created_by_user_id: "u-admin",
    });
  });

  it("accepts ttlSeconds: null for a non-expiring token", async () => {
    const { env } = makeEnv();
    const res = await mint(env, { label: "release bot", scopes: ["files:read"], ttlSeconds: null });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { expiresAt: unknown }).expiresAt).toBeNull();
  });

  it.each([
    [{ scopes: ["files:read"] }, "invalid_label"],
    [{ label: "x".repeat(65) }, "invalid_label"],
    [{ label: "CI", scopes: ["workspace:manage"] }, "invalid_scopes"],
    [{ label: "CI", scopes: ["operator:read"] }, "invalid_scopes"],
    [{ label: "CI", ttlSeconds: 0 }, "invalid_ttl"],
  ])("rejects %j with %s", async (body, code) => {
    const { env } = makeEnv();
    const res = await mint(env, body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error.code).toBe(code);
  });

  it("409s a second active token with the same label", async () => {
    const { env } = makeEnv();
    expect((await mint(env, { label: "CI" })).status).toBe(201);
    const res = await mint(env, { label: "CI" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error.code).toBe("service_token_label_taken");
  });

  it("caps active service tokens per workspace", async () => {
    const { env } = makeEnv();
    for (let i = 0; i < MAX_ACTIVE_SERVICE_TOKENS; i++) {
      expect((await mint(env, { label: `bot-${i}` })).status).toBe(201);
    }
    const res = await mint(env, { label: "one-too-many" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error.code).toBe("service_token_limit_reached");
  });

  it("403s a plain member", async () => {
    const { env } = makeEnv({ role: "member" });
    const res = await mint(env, { label: "CI" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrorBody).error.code).toBe("workspace_admin_required");
  });

  it("403s any up_ bearer, including a workspace:manage token", async () => {
    const { env, db } = makeEnv();
    const { token } = await createToken(database(db), {
      workspace: "acme",
      scopes: ["workspace:manage"],
      mintedByUserId: ADMIN.id,
    });
    const res = await app.request(
      "/v1/workspaces/acme/service-tokens",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ label: "CI" }),
      },
      env,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrorBody).error.code).toBe("members_requires_session");
  });

  it("403s a ups_ service-token bearer the same way", async () => {
    const { env } = makeEnv();
    const minted = (await (await mint(env, { label: "CI" })).json()) as { token: string };
    const res = await app.request(
      "/v1/workspaces/acme/service-tokens",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${minted.token}`, "content-type": "application/json" },
        body: JSON.stringify({ label: "CI 2" }),
      },
      env,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrorBody).error.code).toBe("members_requires_session");
  });
});

describe("token prefixes", () => {
  it("parses the workspace from personal and service tokens", () => {
    expect(workspaceNameFromToken("up_acme_secret")).toBe("acme");
    expect(workspaceNameFromToken("ups_acme_secret")).toBe("acme");
    expect(workspaceNameFromToken("upx_acme_secret")).toBeUndefined();
  });

  it("recognizes both prefixes as workspace-token shaped", () => {
    expect(isWorkspaceTokenShaped("up_acme_x")).toBe(true);
    expect(isWorkspaceTokenShaped("ups_acme_x")).toBe(true);
    expect(isWorkspaceTokenShaped("better-auth-session")).toBe(false);
    expect(isWorkspaceTokenShaped(undefined)).toBe(false);
  });
});

describe("GET / DELETE /v1/workspaces/:workspace/service-tokens", () => {
  it("lists only service tokens, never personal ones or secrets", async () => {
    const { env, db } = makeEnv();
    await createToken(database(db), {
      workspace: "acme",
      label: "laptop",
      scopes: ["files:read"],
      mintedByUserId: ADMIN.id,
    });
    await mint(env, { label: "CI" });
    const res = await app.request("/v1/workspaces/acme/service-tokens", { headers: session }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tokens: Record<string, unknown>[] };
    expect(body.tokens.map((t) => t.label)).toEqual(["CI"]);
    expect(body.tokens[0]).not.toHaveProperty("token");
    expect(JSON.stringify(body)).not.toContain("token_hash");
  });

  it("revokes by id, and the revoked token stops authenticating", async () => {
    const { env } = makeEnv();
    const minted = (await (await mint(env, { label: "CI" })).json()) as {
      id: string;
      token: string;
    };
    const probe = new Hono<WorkspaceVars>()
      .get("/v1/:workspace/probe", workspaceAuth, (c) => c.json(c.get("uploaderIdentity")))
      .onError((err, c) => respondError(c, err));
    const bearer = { Authorization: `Bearer ${minted.token}` };

    const before = await probe.request("/v1/acme/probe", { headers: bearer }, env);
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ kind: "service", tokenId: minted.id, label: "CI" });

    const res = await app.request(
      `/v1/workspaces/acme/service-tokens/${minted.id}`,
      { method: "DELETE", headers: session },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: minted.id, workspace: "acme", revoked: true });

    const after = await probe.request("/v1/acme/probe", { headers: bearer }, env);
    expect(after.status).toBe(401);
  });

  it("404s revoking a personal token by id", async () => {
    const { env, db } = makeEnv();
    const personal = await createToken(database(db), {
      workspace: "acme",
      scopes: ["files:read"],
      mintedByUserId: ADMIN.id,
    });
    const res = await app.request(
      `/v1/workspaces/acme/service-tokens/${personal.record.id}`,
      { method: "DELETE", headers: session },
      env,
    );
    expect(res.status).toBe(404);
  });
});

describe("withUploaderTags for service tokens", () => {
  const env = {} as Env;
  const SERVICE: UploaderIdentity = { kind: "service", tokenId: "tok-1", label: "CI" };

  it("attributes a gh.* upload to the label and drops client uploader keys", async () => {
    const tagged = await withUploaderTags(
      env,
      { "gh.repo": "acme/app", "gh.uploader": "someone", "gh.uploader-id": "u-spoof" },
      SERVICE,
      24,
    );
    expect(tagged).toEqual({
      "gh.repo": "acme/app",
      "gh.uploader": "CI",
      "gh.uploader-kind": "service",
    });
  });

  it("leaves non-gh metadata untouched", async () => {
    const meta = { path: "/settings" };
    expect(await withUploaderTags(env, meta, SERVICE, 24)).toBe(meta);
  });

  it("keeps the client's pairs when the tags would exceed the key cap", async () => {
    const meta = { "gh.repo": "acme/app", a: "1" };
    expect(await withUploaderTags(env, meta, SERVICE, 2)).toBe(meta);
  });
});

describe("uploaderIdentityOf", () => {
  const row = { id: "tok-1", label: "CI", owner: "member" as const, minting_user_id: null };

  it("maps each token shape to one identity", () => {
    expect(uploaderIdentityOf(null)).toEqual({ kind: "none" });
    expect(uploaderIdentityOf(row)).toEqual({ kind: "none" });
    expect(uploaderIdentityOf({ ...row, minting_user_id: "u-1" })).toEqual({
      kind: "user",
      userId: "u-1",
    });
    expect(uploaderIdentityOf({ ...row, owner: "workspace" })).toEqual({
      kind: "service",
      tokenId: "tok-1",
      label: "CI",
    });
    expect(uploaderIdentityOf({ ...row, owner: "workspace", label: "  " })).toMatchObject({
      label: "service token",
    });
  });

  it("exposes a user id only for user identities", () => {
    expect(mintingUserIdOf({ kind: "user", userId: "u-1" })).toBe("u-1");
    expect(mintingUserIdOf({ kind: "service", tokenId: "tok-1", label: "CI" })).toBeNull();
    expect(mintingUserIdOf({ kind: "none" })).toBeNull();
    expect(mintingUserIdOf(undefined)).toBeNull();
  });
});
