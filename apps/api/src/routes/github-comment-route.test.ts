import { describe, expect, it } from "vitest";
import { app } from "../index";
import { sha256Hex, type WorkspaceRecord } from "../workspace";
import { FakeKv } from "../../test/fake-kv";
import { FakeR2Bucket } from "../../test/fake-r2";
import { UsageFakeD1 } from "../../test/usage-fake-d1";
import { GITHUB_APP_CFG_ENV } from "../../test/github-app-env";
import { RepoLinksTable } from "../../test/helpers/fake-repo-links-table";

/**
 * A minimal D1 stand-in (galleries read a no-op) with a real `RepoLinksTable`
 * wired in, for the implicit-claim tests below. `mintingUserId`, when
 * supplied, makes the `auth_tokens` lookup return a D1 token row carrying
 * that minting user id — the same shape `workspaceAuth` reads via
 * `findActiveToken`/`d1Token.minting_user_id` (workspace.ts) — so
 * `isEntitledToClaimRepo` (issue #297) has an identity to resolve. Omitted
 * (the default), `auth_tokens` returns null: the legacy/no-tracked-user path
 * that must always be treated as "not entitled" to claim a NEW repo.
 */
function claimTestDb(mintingUserId?: string): { db: D1Database; links: RepoLinksTable } {
  const links = new RepoLinksTable();
  const db = {
    prepare: (sql: string) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      let values: unknown[] = [];
      const stmt = {
        bind: (...v: unknown[]) => {
          values = v;
          return stmt;
        },
        first: async () => {
          if (mintingUserId && normalized.startsWith("SELECT id, workspace, token_hash")) {
            return {
              id: "token-id",
              workspace: WS,
              token_hash: values[1] as string,
              label: null,
              scopes: JSON.stringify(["files:read", "files:write", "files:delete"]),
              created_at: "2026-07-13T00:00:00.000Z",
              expires_at: null,
              revoked_at: null,
              minting_user_id: mintingUserId,
            };
          }
          return links.tryFirst(normalized, values) ?? null;
        },
        all: async () => ({ results: [] }),
        run: async () => links.tryRun(normalized, values) ?? {},
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, links };
}

// `crypto.subtle.timingSafeEqual` is a Workers-runtime extension to Web
// Crypto (used by workspaceAuth, see ../workspace.ts) that plain Node's
// `crypto` doesn't implement, and this repo has no vitest workerd pool
// configured. Polyfill a (non-constant-time, test-only) equivalent so this
// file can exercise the real workspaceAuth middleware end to end.
if (typeof crypto.subtle.timingSafeEqual !== "function") {
  (
    crypto.subtle as unknown as { timingSafeEqual: (a: Uint8Array, b: Uint8Array) => boolean }
  ).timingSafeEqual = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((byte, i) => byte === b[i]);
}

const WS = "acme";
const TOKEN = "up_acme_testtoken";

async function seededEnv(opts: { installNone?: boolean } = {}): Promise<Env> {
  const hash = await sha256Hex(TOKEN);
  const record: WorkspaceRecord = {
    provider: "r2",
    bucket: "b",
    tokens: [{ hash, createdAt: new Date().toISOString() }],
  };
  const registry = {
    get: (async (key: string) =>
      key === `ws:${WS}` ? record : null) as unknown as KVNamespace["get"],
  };
  const githubCache = new FakeKv();
  if (opts.installNone) githubCache.store.set("ghinst:acme/web", { value: "none" });
  return {
    REGISTRY: registry,
    DB: new UsageFakeD1(),
    GITHUB_CACHE: githubCache,
    ...GITHUB_APP_CFG_ENV,
  } as unknown as Env;
}

function post(env: Env, body: unknown) {
  return app.request(
    `/v1/${WS}/github/comment`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe("POST /v1/:workspace/github/comment", () => {
  it("returns not_installed when the App has no installation for the repo", async () => {
    const env = await seededEnv({ installNone: true });
    const res = await post(env, { repo: "acme/web", num: 12, kind: "pull" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ posted: false, reason: "not_installed" });
  });

  it("400s on a malformed body", async () => {
    const env = await seededEnv();
    const res = await post(env, { repo: "not-a-repo", num: 0, kind: "nope" });
    expect(res.status).toBe(400);
  });

  it("400s on a dot-only repo segment (path-traversal guard)", async () => {
    const env = await seededEnv();
    const res = await post(env, { repo: "../etc", num: 12, kind: "pull" });
    expect(res.status).toBe(400);
  });

  it("posts as the bot and returns the upsert result end-to-end", async () => {
    const hash = await sha256Hex(TOKEN);
    const record: WorkspaceRecord = {
      provider: "r2",
      bucket: "b",
      binding: "UPLOADS_DEFAULT",
      prefix: "acme/",
      publicBaseUrl: "https://storage.uploads.sh",
      tokens: [{ hash, createdAt: new Date().toISOString() }],
    };
    const registry = {
      get: (async (key: string) =>
        key === `ws:${WS}` ? record : null) as unknown as KVNamespace["get"],
    };
    const githubCache = new FakeKv();
    githubCache.store.set("ghinst:acme/web", { value: "42" }); // installed
    githubCache.store.set("ghtok:42", { value: "cached-token" }); // skip JWT mint
    // Grants claim entitlement (issue #297): "acme/web" is unbound, so the
    // caller's identity must resolve to a repo collaborator. This test isn't
    // about the entitlement gate itself — just the posting flow past it.
    githubCache.store.set("ghlogin:user-1", { value: "octocat" });
    const bucket = new FakeR2Bucket();
    await bucket.put("acme/gh/acme/web/pull/12/hero.png", new Uint8Array([0x89, 0x50]), {
      httpMetadata: { contentType: "image/png" },
    });
    const { db } = claimTestDb("user-1");
    const env = {
      REGISTRY: registry,
      DB: db,
      GITHUB_CACHE: githubCache,
      UPLOADS_DEFAULT: bucket,
      ...GITHUB_APP_CFG_ENV,
    } as unknown as Env;

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      if (String(url).includes("/collaborators/octocat/permission")) {
        return new Response(JSON.stringify({ permission: "write" }), { status: 200 });
      }
      if (String(url).includes("/issues/12/comments")) {
        return init.method === "POST"
          ? new Response(
              JSON.stringify({ id: 5, html_url: "https://github.com/acme/web/pull/12#c5" }),
              { status: 201 },
            )
          : new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    try {
      const res = await post(env, { repo: "acme/web", num: 12, kind: "pull" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        posted: true,
        action: "created",
        count: 1,
        commentUrl: "https://github.com/acme/web/pull/12#c5",
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("enriches a forbidden decline with an actionable message + fix link", async () => {
    const hash = await sha256Hex(TOKEN);
    const record: WorkspaceRecord = {
      provider: "r2",
      bucket: "b",
      binding: "UPLOADS_DEFAULT",
      prefix: "acme/",
      publicBaseUrl: "https://storage.uploads.sh",
      tokens: [{ hash, createdAt: new Date().toISOString() }],
    };
    const registry = {
      get: (async (key: string) =>
        key === `ws:${WS}` ? record : null) as unknown as KVNamespace["get"],
    };
    const githubCache = new FakeKv();
    githubCache.store.set("ghinst:acme/web", { value: "42" });
    githubCache.store.set("ghtok:42", { value: "cached-token" });
    // Grants claim entitlement (issue #297) — see the "posts as the bot" test above.
    githubCache.store.set("ghlogin:user-1", { value: "octocat" });
    const bucket = new FakeR2Bucket();
    await bucket.put("acme/gh/acme/web/pull/12/hero.png", new Uint8Array([0x89, 0x50]), {
      httpMetadata: { contentType: "image/png" },
    });
    const { db } = claimTestDb("user-1");
    const env = {
      REGISTRY: registry,
      DB: db,
      GITHUB_CACHE: githubCache,
      UPLOADS_DEFAULT: bucket,
      ...GITHUB_APP_CFG_ENV,
    } as unknown as Env;

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes("/collaborators/octocat/permission")) {
        return new Response(JSON.stringify({ permission: "write" }), { status: 200 });
      }
      return String(url).includes("/issues/12/comments")
        ? new Response("no", { status: 403 }) // App lacks write
        : new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    try {
      const res = await post(env, { repo: "acme/web", num: 12, kind: "pull" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        posted: boolean;
        reason: string;
        message: string;
        fixUrl: string;
        required: string[];
      };
      expect(body.posted).toBe(false);
      expect(body.reason).toBe("forbidden");
      expect(body.message).toContain("Issues and Pull requests write");
      expect(body.fixUrl).toBe(
        "https://github.com/organizations/acme/settings/installations/42/permissions/update",
      );
      expect(body.required).toEqual(["issues:write", "pull_requests:write"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("POST /v1/:workspace/github/comment implicit repo-link claim", () => {
  async function envWithBucket(db: D1Database): Promise<Env> {
    const hash = await sha256Hex(TOKEN);
    const record: WorkspaceRecord = {
      provider: "r2",
      bucket: "b",
      binding: "UPLOADS_DEFAULT",
      prefix: "acme/",
      publicBaseUrl: "https://storage.uploads.sh",
      tokens: [{ hash, createdAt: new Date().toISOString() }],
    };
    const registry = {
      get: (async (key: string) =>
        key === `ws:${WS}` ? record : null) as unknown as KVNamespace["get"],
    };
    const githubCache = new FakeKv();
    githubCache.store.set("ghinst:acme/web", { value: "42" });
    githubCache.store.set("ghtok:42", { value: "cached-token" });
    // Grants claim entitlement (issue #297) — "acme/web" is unbound in every
    // test in this describe block, so the caller's identity must resolve to
    // a repo collaborator before the implicit-claim path is even reached.
    githubCache.store.set("ghlogin:user-1", { value: "octocat" });
    const bucket = new FakeR2Bucket();
    await bucket.put("acme/gh/acme/web/pull/12/hero.png", new Uint8Array([0x89, 0x50]), {
      httpMetadata: { contentType: "image/png" },
    });
    return {
      REGISTRY: registry,
      DB: db,
      GITHUB_CACHE: githubCache,
      UPLOADS_DEFAULT: bucket,
      ...GITHUB_APP_CFG_ENV,
    } as unknown as Env;
  }

  it("records a link when the comment actually posts", async () => {
    const { db, links } = claimTestDb("user-1");
    const env = await envWithBucket(db);

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      if (String(url).includes("/collaborators/octocat/permission")) {
        return new Response(JSON.stringify({ permission: "write" }), { status: 200 });
      }
      if (String(url).includes("/issues/12/comments")) {
        return init.method === "POST"
          ? new Response(
              JSON.stringify({ id: 5, html_url: "https://github.com/acme/web/pull/12#c5" }),
              { status: 201 },
            )
          : new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    try {
      const res = await post(env, { repo: "acme/web", num: 12, kind: "pull" });
      expect(res.status).toBe(200);
      const link = links.rows.get("acme/web");
      expect(link).toMatchObject({ workspace_name: WS, source: "comment", installation_id: 42 });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("does not record a link when nothing was posted (degrade)", async () => {
    const { db, links } = claimTestDb("user-1");
    const env = await envWithBucket(db);

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes("/collaborators/octocat/permission")) {
        return new Response(JSON.stringify({ permission: "write" }), { status: 200 });
      }
      return String(url).includes("/issues/12/comments")
        ? new Response("no", { status: 403 })
        : new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    try {
      const res = await post(env, { repo: "acme/web", num: 12, kind: "pull" });
      expect(res.status).toBe(200);
      expect(links.rows.has("acme/web")).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("does not record a link when gathering skips (nothing to post)", async () => {
    const { db, links } = claimTestDb("user-1");
    const hash = await sha256Hex(TOKEN);
    const record: WorkspaceRecord = {
      provider: "r2",
      bucket: "b",
      binding: "UPLOADS_DEFAULT",
      prefix: "acme/",
      publicBaseUrl: "https://storage.uploads.sh",
      tokens: [{ hash, createdAt: new Date().toISOString() }],
    };
    const registry = {
      get: (async (key: string) =>
        key === `ws:${WS}` ? record : null) as unknown as KVNamespace["get"],
    };
    const githubCache = new FakeKv();
    githubCache.store.set("ghinst:acme/web", { value: "42" });
    githubCache.store.set("ghtok:42", { value: "cached-token" });
    githubCache.store.set("ghlogin:user-1", { value: "octocat" });
    const env = {
      REGISTRY: registry,
      DB: db,
      GITHUB_CACHE: githubCache,
      UPLOADS_DEFAULT: new FakeR2Bucket(),
      ...GITHUB_APP_CFG_ENV,
    } as unknown as Env;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) =>
      String(url).includes("/collaborators/octocat/permission")
        ? new Response(JSON.stringify({ permission: "write" }), { status: 200 })
        : new Response("nf", { status: 404 })) as unknown as typeof fetch;
    try {
      const res = await post(env, { repo: "acme/web", num: 12, kind: "pull" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ posted: true, action: "skipped", count: 0 });
      expect(links.rows.has("acme/web")).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("POST /v1/:workspace/github/comment cross-tenant authorization (issue #297)", () => {
  async function envWithBucketAndLinks(
    db: D1Database,
    opts: { workspace?: string; prefix?: string } = {},
  ): Promise<Env> {
    const ws = opts.workspace ?? WS;
    const hash = await sha256Hex(TOKEN);
    const record: WorkspaceRecord = {
      provider: "r2",
      bucket: "b",
      binding: "UPLOADS_DEFAULT",
      prefix: opts.prefix ?? `${ws}/`,
      publicBaseUrl: "https://storage.uploads.sh",
      tokens: [{ hash, createdAt: new Date().toISOString() }],
    };
    const registry = {
      get: (async (key: string) =>
        key === `ws:${ws}` ? record : null) as unknown as KVNamespace["get"],
    };
    const githubCache = new FakeKv();
    githubCache.store.set("ghinst:orgB/repo", { value: "42" });
    githubCache.store.set("ghtok:42", { value: "cached-token" });
    const bucket = new FakeR2Bucket();
    await bucket.put(
      `${record.prefix}gh/orgB/repo/pull/12/hero.png`,
      new Uint8Array([0x89, 0x50]),
      { httpMetadata: { contentType: "image/png" } },
    );
    return {
      REGISTRY: registry,
      DB: db,
      GITHUB_CACHE: githubCache,
      UPLOADS_DEFAULT: bucket,
      ...GITHUB_APP_CFG_ENV,
    } as unknown as Env;
  }

  function postAs(env: Env, workspace: string, token: string, body: unknown) {
    return app.request(
      `/v1/${workspace}/github/comment`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      env,
    );
  }

  it("allows the comment when the caller owns the repo's binding", async () => {
    const { db, links } = claimTestDb();
    links.rows.set("orgb/repo", {
      repo_full_name: "orgb/repo",
      workspace_name: WS,
      installation_id: 42,
      source: "comment",
      created_at: new Date().toISOString(),
    });
    const env = await envWithBucketAndLinks(db);

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      if (String(url).includes("/issues/12/comments")) {
        return init.method === "POST"
          ? new Response(
              JSON.stringify({ id: 5, html_url: "https://github.com/orgB/repo/pull/12#c5" }),
              { status: 201 },
            )
          : new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    try {
      const res = await postAs(env, WS, TOKEN, { repo: "orgB/repo", num: 12, kind: "pull" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { posted: boolean };
      expect(body.posted).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("implicitly claims an unbound repo when the caller is verified entitled to it", async () => {
    const { db, links } = claimTestDb("user-1");
    const env = await envWithBucketAndLinks(db);
    (env as unknown as { GITHUB_CACHE: FakeKv }).GITHUB_CACHE.store.set("ghlogin:user-1", {
      value: "octocat",
    });

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      if (String(url).includes("/collaborators/octocat/permission")) {
        return new Response(JSON.stringify({ permission: "write" }), { status: 200 });
      }
      if (String(url).includes("/issues/12/comments")) {
        return init.method === "POST"
          ? new Response(
              JSON.stringify({ id: 5, html_url: "https://github.com/orgB/repo/pull/12#c5" }),
              { status: 201 },
            )
          : new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    try {
      const res = await postAs(env, WS, TOKEN, { repo: "orgB/repo", num: 12, kind: "pull" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { posted: boolean };
      expect(body.posted).toBe(true);
      const link = links.rows.get("orgb/repo");
      expect(link).toMatchObject({ workspace_name: WS, source: "comment" });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("declines the cross-tenant claim: a legacy/shared token can't claim a NEW repo", async () => {
    // No minting user (the default `claimTestDb()` shape) — this is exactly
    // the exploit path from issue #297: workspace A's own uploaded images
    // under a crafted `gh/<org B>/...` prefix must not let it become org B's
    // repo's bound workspace, let alone post as uploads-sh[bot] there.
    const { db, links } = claimTestDb();
    const env = await envWithBucketAndLinks(db);

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("nf", { status: 404 })) as unknown as typeof fetch;
    try {
      const res = await postAs(env, WS, TOKEN, { repo: "orgB/repo", num: 12, kind: "pull" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { posted: boolean; reason: string; message: string };
      expect(body.posted).toBe(false);
      expect(body.reason).toBe("not_authorized");
      expect(body.message).toContain("orgB/repo");
      // No GitHub API call happened, and no claim was recorded.
      expect(links.rows.has("orgb/repo")).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("declines the cross-tenant claim when the caller's GitHub identity lacks write access", async () => {
    const { db, links } = claimTestDb("user-1");
    const env = await envWithBucketAndLinks(db);
    (env as unknown as { GITHUB_CACHE: FakeKv }).GITHUB_CACHE.store.set("ghlogin:user-1", {
      value: "mallory",
    });

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) =>
      String(url).includes("/collaborators/mallory/permission")
        ? new Response(JSON.stringify({ permission: "read" }), { status: 200 })
        : new Response("nf", { status: 404 })) as unknown as typeof fetch;
    try {
      const res = await postAs(env, WS, TOKEN, { repo: "orgB/repo", num: 12, kind: "pull" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { posted: boolean; reason: string };
      expect(body.posted).toBe(false);
      expect(body.reason).toBe("not_authorized");
      expect(links.rows.has("orgb/repo")).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("soft-declines when the repo is bound to a different workspace", async () => {
    const { db, links } = claimTestDb();
    links.rows.set("orgb/repo", {
      repo_full_name: "orgb/repo",
      workspace_name: "other-ws",
      installation_id: 42,
      source: "comment",
      created_at: new Date().toISOString(),
    });
    const env = await envWithBucketAndLinks(db);

    const res = await postAs(env, WS, TOKEN, { repo: "orgB/repo", num: 12, kind: "pull" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { posted: boolean; reason: string; message: string };
    expect(body).toEqual({
      posted: false,
      reason: "not_authorized",
      message: expect.stringContaining('bound to a different workspace ("other-ws")'),
    });
    // The decline must fire before any GitHub API call or implicit claim.
    expect(links.rows.get("orgb/repo")?.workspace_name).toBe("other-ws");
  });

  it("never allows posting when the strict repo-link lookup hits a D1 outage", async () => {
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => {
            throw new Error("D1 unavailable");
          },
          all: async () => ({ results: [] }),
          run: async () => ({}),
        }),
      }),
    } as unknown as D1Database;
    const env = await envWithBucketAndLinks(db);

    const res = await postAs(env, WS, TOKEN, { repo: "orgB/repo", num: 12, kind: "pull" });
    // Never a silent allow: the outage must not degrade to "unbound".
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});
