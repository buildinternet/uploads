import { describe, expect, it } from "vitest";
import { app } from "../index";
import { sha256Hex, type WorkspaceRecord } from "../workspace";
import { FakeKv } from "../../test/fake-kv";
import { FakeR2Bucket } from "../../test/fake-r2";
import { UsageFakeD1 } from "../../test/usage-fake-d1";
import { GITHUB_APP_CFG_ENV } from "../../test/github-app-env";
import { RepoLinksTable } from "../../test/helpers/fake-repo-links-table";

/**
 * A minimal D1 stand-in (auth-token lookup + galleries read both no-op) with
 * a real `RepoLinksTable` wired in, for the implicit-claim tests below —
 * mirrors the inline `db` object the "posts as the bot" test above already
 * uses, extended so `github_repo_links` statements actually persist.
 */
function claimTestDb(): { db: D1Database; links: RepoLinksTable } {
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
        first: async () => links.tryFirst(normalized, values) ?? null,
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
    const bucket = new FakeR2Bucket();
    await bucket.put("acme/gh/acme/web/pull/12/hero.png", new Uint8Array([0x89, 0x50]), {
      httpMetadata: { contentType: "image/png" },
    });
    // Minimal D1: null for the auth-token lookup, empty for the galleries read.
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => null,
          all: async () => ({ results: [] }),
          run: async () => ({}),
        }),
      }),
    } as unknown as D1Database;
    const env = {
      REGISTRY: registry,
      DB: db,
      GITHUB_CACHE: githubCache,
      UPLOADS_DEFAULT: bucket,
      ...GITHUB_APP_CFG_ENV,
    } as unknown as Env;

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
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
    const bucket = new FakeR2Bucket();
    await bucket.put("acme/gh/acme/web/pull/12/hero.png", new Uint8Array([0x89, 0x50]), {
      httpMetadata: { contentType: "image/png" },
    });
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => null,
          all: async () => ({ results: [] }),
          run: async () => ({}),
        }),
      }),
    } as unknown as D1Database;
    const env = {
      REGISTRY: registry,
      DB: db,
      GITHUB_CACHE: githubCache,
      UPLOADS_DEFAULT: bucket,
      ...GITHUB_APP_CFG_ENV,
    } as unknown as Env;

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) =>
      String(url).includes("/issues/12/comments")
        ? new Response("no", { status: 403 }) // App lacks write
        : new Response("nf", { status: 404 })) as unknown as typeof fetch;
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
    const { db, links } = claimTestDb();
    const env = await envWithBucket(db);

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
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
    const { db, links } = claimTestDb();
    const env = await envWithBucket(db);

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) =>
      String(url).includes("/issues/12/comments")
        ? new Response("no", { status: 403 })
        : new Response("nf", { status: 404 })) as unknown as typeof fetch;
    try {
      const res = await post(env, { repo: "acme/web", num: 12, kind: "pull" });
      expect(res.status).toBe(200);
      expect(links.rows.has("acme/web")).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("does not record a link when gathering skips (nothing to post)", async () => {
    const { db, links } = claimTestDb();
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
    const env = {
      REGISTRY: registry,
      DB: db,
      GITHUB_CACHE: githubCache,
      UPLOADS_DEFAULT: new FakeR2Bucket(),
      ...GITHUB_APP_CFG_ENV,
    } as unknown as Env;

    const res = await post(env, { repo: "acme/web", num: 12, kind: "pull" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ posted: true, action: "skipped", count: 0 });
    expect(links.rows.has("acme/web")).toBe(false);
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

  it("implicitly claims an unbound repo for a non-communal workspace", async () => {
    const { db, links } = claimTestDb();
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
      const link = links.rows.get("orgb/repo");
      expect(link).toMatchObject({ workspace_name: WS, source: "comment" });
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

  it("soft-declines an unbound repo for the communal default workspace", async () => {
    const { db, links } = claimTestDb();
    const hash = await sha256Hex("up_default_testtoken");
    const record: WorkspaceRecord = {
      provider: "r2",
      bucket: "b",
      binding: "UPLOADS_DEFAULT",
      prefix: "default/",
      publicBaseUrl: "https://storage.uploads.sh",
      tokens: [{ hash, createdAt: new Date().toISOString() }],
    };
    const registry = {
      get: (async (key: string) =>
        key === "ws:default" ? record : null) as unknown as KVNamespace["get"],
    };
    const githubCache = new FakeKv();
    githubCache.store.set("ghinst:orgB/repo", { value: "42" });
    const env = {
      REGISTRY: registry,
      DB: db,
      GITHUB_CACHE: githubCache,
      UPLOADS_DEFAULT: new FakeR2Bucket(),
      ...GITHUB_APP_CFG_ENV,
    } as unknown as Env;

    const res = await postAs(env, "default", "up_default_testtoken", {
      repo: "orgB/repo",
      num: 12,
      kind: "pull",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { posted: boolean; reason: string; message: string };
    expect(body.posted).toBe(false);
    expect(body.reason).toBe("not_authorized");
    expect(body.message).toContain("communal");
    expect(links.rows.has("orgb/repo")).toBe(false);
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
