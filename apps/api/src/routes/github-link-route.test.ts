import { describe, expect, it } from "vitest";
import { app } from "../index";
import { sha256Hex, type WorkspaceRecord } from "../workspace";
import { FakeKv } from "../../test/fake-kv";
import { UsageFakeD1 } from "../../test/usage-fake-d1";
import { GITHUB_APP_CFG_ENV } from "../../test/github-app-env";

// Same node-vs-workerd Web Crypto gap as github-promote-route.test.ts — this
// suite exercises the real workspaceAuth middleware end to end.
if (typeof crypto.subtle.timingSafeEqual !== "function") {
  (
    crypto.subtle as unknown as { timingSafeEqual: (a: Uint8Array, b: Uint8Array) => boolean }
  ).timingSafeEqual = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((byte, i) => byte === b[i]);
}

const WS = "acme";
const TOKEN = "up_acme_testtoken";
const REPO = "acme/web";

interface Seeded {
  env: Env;
  db: UsageFakeD1;
}

async function seededEnv(
  workspace = WS,
  token = TOKEN,
  opts: { mintingUserId?: string } = {},
): Promise<Seeded> {
  const record: WorkspaceRecord = {
    provider: "r2",
    bucket: "b",
    binding: "UPLOADS_DEFAULT",
    prefix: `${workspace}/`,
    publicBaseUrl: "https://storage.uploads.sh",
    tokens: [{ hash: await sha256Hex(token), createdAt: new Date().toISOString() }],
  };
  const registry = {
    get: (async (key: string) =>
      key === `ws:${workspace}` ? record : null) as unknown as KVNamespace["get"],
  };
  const db = new UsageFakeD1();
  const githubCache = new FakeKv();
  const env = {
    REGISTRY: registry,
    DB: db,
    GITHUB_CACHE: githubCache,
    ...GITHUB_APP_CFG_ENV,
  } as unknown as Env;

  if (opts.mintingUserId) {
    // Layer a D1-backed token carrying a minting user id (issue #297's
    // claim-authorization gate reads it via `c.get("mintingUserId")`) — same
    // shape `workspaceAuth` reads via `findActiveToken` (workspace.ts).
    const hash = await sha256Hex(token);
    const mintingUserId = opts.mintingUserId;
    const originalPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized.startsWith("SELECT id, workspace, token_hash")) {
        let args: unknown[] = [];
        return {
          bind: (...v: unknown[]) => {
            args = v;
            return {
              first: async () => {
                const tokHash = args[1] as string;
                if (tokHash !== hash) return null;
                return {
                  id: "token-id",
                  workspace,
                  token_hash: hash,
                  label: null,
                  scopes: JSON.stringify(["files:read", "files:write", "files:delete"]),
                  created_at: "2026-07-13T00:00:00.000Z",
                  expires_at: null,
                  revoked_at: null,
                  minting_user_id: mintingUserId,
                };
              },
              all: async () => ({ results: [] }),
              run: async () => ({}),
            };
          },
        };
      }
      return originalPrepare(sql);
    }) as typeof db.prepare;
  }

  return { env, db };
}

function get(env: Env, workspace: string, repo: string, token: string) {
  return app.request(
    `/v1/${workspace}/github/link?repo=${encodeURIComponent(repo)}`,
    {
      headers: { authorization: `Bearer ${token}` },
    },
    env,
  );
}

function post(env: Env, workspace: string, body: unknown, token: string) {
  return app.request(
    `/v1/${workspace}/github/link`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

function del(env: Env, workspace: string, repo: string, token: string) {
  return app.request(
    `/v1/${workspace}/github/link?repo=${encodeURIComponent(repo)}`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    },
    env,
  );
}

describe("GET /v1/:workspace/github/link", () => {
  it("reports no binding when the repo is unclaimed", async () => {
    const { env } = await seededEnv();
    const res = await get(env, WS, REPO, TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ repo: REPO, linked: false, workspace: null });
  });

  it("reports the binding when the repo is claimed", async () => {
    const { env, db } = await seededEnv();
    db.repoLinks.set(REPO, {
      repo_full_name: REPO,
      workspace_name: WS,
      installation_id: null,
      source: "comment",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    const res = await get(env, WS, REPO, TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ repo: REPO, linked: true, workspace: WS });
  });

  it("400s on a malformed repo", async () => {
    const { env } = await seededEnv();
    const res = await get(env, WS, "not-a-repo", TOKEN);
    expect(res.status).toBe(400);
  });

  it("401s with no bearer token", async () => {
    const { env } = await seededEnv();
    const res = await app.request(`/v1/${WS}/github/link?repo=${REPO}`, {}, env);
    expect(res.status).toBe(401);
  });
});

describe("POST /v1/:workspace/github/link", () => {
  it("claims an unbound repo when the caller is verified entitled to it", async () => {
    const { env, db } = await seededEnv(WS, TOKEN, { mintingUserId: "user-1" });
    (env as unknown as { GITHUB_CACHE: FakeKv }).GITHUB_CACHE.store.set("ghinst:acme/web", {
      value: "42",
    });
    (env as unknown as { GITHUB_CACHE: FakeKv }).GITHUB_CACHE.store.set("ghtok:42", {
      value: "cached-token",
    });
    (env as unknown as { GITHUB_CACHE: FakeKv }).GITHUB_CACHE.store.set("ghlogin:user-1", {
      value: "octocat",
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) =>
      String(url).includes("/collaborators/octocat/permission")
        ? new Response(JSON.stringify({ permission: "write" }), { status: 200 })
        : new Response("nf", { status: 404 })) as unknown as typeof fetch;
    try {
      const res = await post(env, WS, { repo: REPO }, TOKEN);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ claimed: true, workspace: WS, source: "cli" });
      expect(db.repoLinks.get(REPO)).toMatchObject({ workspace_name: WS, source: "cli" });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("declines to claim an unbound repo when the caller can't be verified entitled (issue #297)", async () => {
    // No minting user — a legacy/shared token (e.g. the communal `default`
    // workspace) can't be tied to a GitHub identity, so `uploads github
    // link` must not let it claim a repo it has no proven access to.
    const { env, db } = await seededEnv();
    const res = await post(env, WS, { repo: REPO }, TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      claimed: false,
      reason: "not_authorized",
      linked: false,
      workspace: null,
    });
    expect(db.repoLinks.has(REPO)).toBe(false);
  });

  it("honestly reports an already-bound-by-another-workspace repo (claimed: false)", async () => {
    const { env, db } = await seededEnv();
    db.repoLinks.set(REPO, {
      repo_full_name: REPO,
      workspace_name: "someone-else",
      installation_id: null,
      source: "comment",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    const res = await post(env, WS, { repo: REPO }, TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      claimed: false,
      linked: true,
      workspace: "someone-else",
    });
    // First-claim-wins: never overwritten.
    expect(db.repoLinks.get(REPO)?.workspace_name).toBe("someone-else");
  });

  it("is idempotent for the owning workspace (claimed: true, no duplicate row)", async () => {
    const { env, db } = await seededEnv();
    db.repoLinks.set(REPO, {
      repo_full_name: REPO,
      workspace_name: WS,
      installation_id: null,
      source: "comment",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    const res = await post(env, WS, { repo: REPO }, TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ claimed: true, workspace: WS, source: "comment" });
  });

  it("400s on a malformed repo", async () => {
    const { env } = await seededEnv();
    const res = await post(env, WS, { repo: "../etc" }, TOKEN);
    expect(res.status).toBe(400);
  });

  it("401s with no bearer token", async () => {
    const { env } = await seededEnv();
    const res = await app.request(
      `/v1/${WS}/github/link`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: REPO }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });
});

describe("DELETE /v1/:workspace/github/link", () => {
  it("unlinks a binding owned by the calling workspace", async () => {
    const { env, db } = await seededEnv();
    db.repoLinks.set(REPO, {
      repo_full_name: REPO,
      workspace_name: WS,
      installation_id: null,
      source: "cli",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    const res = await del(env, WS, REPO, TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ repo: REPO, unlinked: true });
    expect(db.repoLinks.has(REPO)).toBe(false);
  });

  it("reports not_linked for an unclaimed repo without erroring", async () => {
    const { env } = await seededEnv();
    const res = await del(env, WS, REPO, TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ repo: REPO, unlinked: false, reason: "not_linked" });
  });

  it("403s when the caller does not own the binding, and leaves it intact", async () => {
    const { env, db } = await seededEnv();
    db.repoLinks.set(REPO, {
      repo_full_name: REPO,
      workspace_name: "someone-else",
      installation_id: null,
      source: "comment",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    const res = await del(env, WS, REPO, TOKEN);
    expect(res.status).toBe(403);
    expect(db.repoLinks.get(REPO)?.workspace_name).toBe("someone-else");
  });

  it("400s on a malformed repo", async () => {
    const { env } = await seededEnv();
    const res = await del(env, WS, "not-a-repo", TOKEN);
    expect(res.status).toBe(400);
  });

  it("401s with no bearer token", async () => {
    const { env } = await seededEnv();
    const res = await app.request(`/v1/${WS}/github/link?repo=${REPO}`, { method: "DELETE" }, env);
    expect(res.status).toBe(401);
  });

  it("propagates a D1 read failure instead of reporting not_linked", async () => {
    const { env } = await seededEnv();
    const failingDb = {
      prepare: () => ({
        bind: () => ({
          first: async () => {
            throw new Error("d1 unavailable");
          },
        }),
      }),
    };
    const res = await del({ ...env, DB: failingDb } as unknown as Env, WS, REPO, TOKEN);
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});
