/**
 * Hosted `put` PR/issue targeting + managed comment sync (issue #392). The
 * gather/check/upsert logic itself is exercised end-to-end by
 * apps/api/src/routes/github-comment-route.test.ts (now via
 * `postManagedComment`, apps/api/src/github-comment-service.ts) — these tests
 * cover only the hosted MCP `put` tool's new surface: targeting args, the
 * `comment` opt-in, and that a decline/failure never fails the upload.
 */
import { beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { sha256Hex, type WorkspaceRecord } from "@uploads/api/workspace";
import { FakeR2Bucket } from "@uploads/storage/test/fake-r2";

const TOKEN = "up_test-ws_legacy-token-value";
const WS = "test-ws";

// crypto.subtle.timingSafeEqual is a Workers-runtime extension (used by
// workspaceAuth) Node's crypto doesn't implement — mirrors mcp.test.ts's polyfill.
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

const GITHUB_APP_CFG_ENV = {
  GITHUB_APP_ID: "12345",
  GITHUB_APP_PRIVATE_KEY: "unused",
  GITHUB_APP_HOME_INSTALLATION_ID: "777",
  WEB_ORIGIN: "https://uploads.sh",
};

/** In-process KV fake: get/put with recorded TTLs — mirrors apps/api/test/fake-kv.ts. */
class FakeKv {
  store = new Map<string, { value: string; expirationTtl?: number }>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key)?.value ?? null;
  }
  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, { value, expirationTtl: opts?.expirationTtl });
  }
}

interface RepoLinkRow {
  repo_full_name: string;
  workspace_name: string;
  installation_id: number | null;
  source: string;
  created_at: string;
}

/** In-memory `github_repo_links` stand-in — mirrors apps/api/test/helpers/fake-repo-links-table.ts. */
class RepoLinksTable {
  readonly rows = new Map<string, RepoLinkRow>();

  tryRun(sql: string, args: unknown[]) {
    if (sql.startsWith("INSERT OR IGNORE INTO github_repo_links")) {
      const [repo, workspace, installationId, source, createdAt] = args as [
        string,
        string,
        number | null,
        string,
        string,
      ];
      if (this.rows.has(repo)) return { success: true, meta: { changes: 0 }, results: [] };
      this.rows.set(repo, {
        repo_full_name: repo,
        workspace_name: workspace,
        installation_id: installationId,
        source,
        created_at: createdAt,
      });
      return { success: true, meta: { changes: 1 }, results: [] };
    }
    return undefined;
  }

  tryFirst(sql: string, args: unknown[]) {
    if (sql.includes("FROM github_repo_links WHERE repo_full_name")) {
      const [repo] = args as [string];
      return this.rows.get(repo) ?? null;
    }
    return undefined;
  }
}

/**
 * Combines the file_metadata fake (gh.* stamping on `putObject`) with a
 * `github_repo_links` table and an `auth_tokens` lookup. By default the
 * active-token lookup always misses (legacy token path — full FILE_SCOPES,
 * `mintingUserId` null; the entitlement/claim path is covered by the
 * route-level tests instead). Pass `scopedToken` to instead return a
 * D1-tracked row for `TOKEN` carrying exactly those scopes, for the
 * files:read-required-for-comment scope test.
 */
function makeDb(
  links: RepoLinksTable,
  metadata: Map<string, Map<string, string>>,
  scopedToken?: { tokenHash: string; scopes: string[] },
) {
  const scopeKey = (ws: string, objectKey: string) => `${ws} ${objectKey}`;
  return {
    prepare: (sql: string) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      let values: unknown[] = [];
      const stmt = {
        bind(...next: unknown[]) {
          values = next;
          return stmt;
        },
        async first<T>() {
          if (normalized.includes("github_repo_links")) {
            return (links.tryFirst(normalized, values) ?? null) as T;
          }
          if (normalized.startsWith("SELECT id, workspace, token_hash")) {
            const [, hash] = values as [string, string];
            if (scopedToken && hash === scopedToken.tokenHash) {
              return {
                id: "token-id",
                workspace: WS,
                token_hash: hash,
                label: null,
                scopes: JSON.stringify(scopedToken.scopes),
                created_at: "2026-07-13T00:00:00.000Z",
                expires_at: null,
                revoked_at: null,
                minting_user_id: null,
              } as T;
            }
            return null as T;
          }
          // auth_tokens active-token lookup: always miss (legacy token path).
          return null as T;
        },
        async run() {
          if (normalized.includes("github_repo_links")) {
            return (
              links.tryRun(normalized, values) ?? {
                success: true,
                meta: { changes: 0 },
                results: [],
              }
            );
          }
          if (normalized.startsWith("INSERT INTO file_metadata")) {
            const [ws, objectKey, key, value] = values as [string, string, string, string];
            const map = metadata.get(scopeKey(ws, objectKey)) ?? new Map<string, string>();
            map.set(key, value);
            metadata.set(scopeKey(ws, objectKey), map);
          } else if (normalized.startsWith("DELETE FROM file_metadata")) {
            const [ws, objectKey] = values as [string, string];
            metadata.delete(scopeKey(ws, objectKey));
          }
          return { success: true, meta: { changes: 0 }, results: [] };
        },
        async all<T>() {
          if (normalized.startsWith("SELECT meta_key, meta_value FROM file_metadata")) {
            const [ws, objectKey] = values as [string, string];
            const map = metadata.get(scopeKey(ws, objectKey)) ?? new Map<string, string>();
            return {
              success: true,
              results: [...map.entries()].map(([meta_key, meta_value]) => ({
                meta_key,
                meta_value,
              })) as T[],
              meta: {},
            };
          }
          return { success: true, results: [] as T[], meta: {} };
        },
      };
      return stmt;
    },
    async batch(stmts: { run: () => Promise<unknown> }[]) {
      return Promise.all(stmts.map((s) => s.run()));
    },
  };
}

async function makeEnv(
  opts: { boundTo?: string; scopes?: string[] } = {},
): Promise<{ env: Env; bucket: FakeR2Bucket; links: RepoLinksTable; githubCache: FakeKv }> {
  const tokenHash = await sha256Hex(TOKEN);
  const record: WorkspaceRecord = {
    provider: "r2",
    bucket: "test-bucket",
    binding: "UPLOADS",
    publicBaseUrl: "https://storage.example.com",
    tokenHash,
  };
  const bucket = new FakeR2Bucket();
  const links = new RepoLinksTable();
  if (opts.boundTo) {
    links.rows.set("acme/widgets", {
      repo_full_name: "acme/widgets",
      workspace_name: opts.boundTo,
      installation_id: 42,
      source: "comment",
      created_at: new Date().toISOString(),
    });
  }
  const metadata = new Map<string, Map<string, string>>();
  const githubCache = new FakeKv();
  const scopedToken = opts.scopes ? { tokenHash, scopes: opts.scopes } : undefined;
  const env = {
    REGISTRY: { get: async (key: string) => (key === `ws:${WS}` ? record : null) },
    DB: makeDb(links, metadata, scopedToken),
    UPLOADS: bucket,
    GITHUB_CACHE: githubCache,
    ...GITHUB_APP_CFG_ENV,
  } as unknown as Env;
  return { env, bucket, links, githubCache };
}

async function callTool(env: Env, name: string, args: Record<string, unknown>) {
  const response = await app.request(
    "/test-ws/mcp",
    {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
      headers: { Authorization: `Bearer ${TOKEN}` },
    },
    env,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    result: {
      isError: boolean;
      structuredContent?: Record<string, unknown>;
      content: unknown[];
    };
  };
  return body.result;
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG_B64 = btoa(String.fromCharCode(...PNG_BYTES));

function stubGithubFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) =>
    handler(String(url), init)) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

describe("hosted put: pr/issue targeting", () => {
  it("uses a stable gh/ key and stamps canonical gh.* metadata", async () => {
    const { env, bucket } = await makeEnv({ boundTo: WS });
    const result = await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "hero.png",
      pr: 12,
      repo: "acme/widgets",
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      key: "gh/acme/widgets/pull/12/hero.png",
      url: "https://storage.example.com/gh/acme/widgets/pull/12/hero.png",
    });
    expect(bucket.store.has("gh/acme/widgets/pull/12/hero.png")).toBe(true);
  });

  it("uses the issues kind for `issue`", async () => {
    const { env } = await makeEnv({ boundTo: WS });
    const result = await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "hero.png",
      issue: 7,
      repo: "acme/widgets",
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      key: "gh/acme/widgets/issues/7/hero.png",
    });
  });

  it("always overwrites a gh/ target key without replace: true (issue #174 has no effect here)", async () => {
    const { env } = await makeEnv({ boundTo: WS });
    const first = await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "hero.png",
      pr: 12,
      repo: "acme/widgets",
    });
    expect(first.isError).toBe(false);
    expect(first.structuredContent).toMatchObject({ replaced: false });

    const second = await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "hero.png",
      pr: 12,
      repo: "acme/widgets",
    });
    expect(second.isError).toBe(false);
    expect(second.structuredContent).toMatchObject({ replaced: true });
  });

  it("usage errors: comment without pr/issue", async () => {
    const { env } = await makeEnv();
    const result = await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "hero.png",
      key: "shots/hero.png",
      comment: true,
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining("comment requires pr or issue") },
    ]);
  });

  it("usage errors: pr without repo", async () => {
    const { env } = await makeEnv();
    const result = await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "hero.png",
      pr: 12,
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining("repo is required") },
    ]);
  });

  it("usage errors: pr + key are mutually exclusive", async () => {
    const { env } = await makeEnv();
    const result = await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "hero.png",
      pr: 12,
      repo: "acme/widgets",
      key: "shots/hero.png",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining("key cannot be combined with pr/issue") },
    ]);
  });

  it("usage errors: pr + issue are mutually exclusive", async () => {
    const { env } = await makeEnv();
    const result = await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "hero.png",
      pr: 12,
      issue: 7,
      repo: "acme/widgets",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining("mutually exclusive") },
    ]);
  });
});

describe("hosted put: comment sync (issue #392)", () => {
  it("posts the managed comment and records a repo link on a bound repo", async () => {
    const { env, links, githubCache } = await makeEnv({ boundTo: WS });
    githubCache.store.set("ghinst:acme/widgets", { value: "42" });
    githubCache.store.set("ghtok:42", { value: "cached-token" });
    const restore = stubGithubFetch((url, init) => {
      if (url.includes("/issues/12/comments")) {
        return init.method === "POST"
          ? new Response(
              JSON.stringify({ id: 5, html_url: "https://github.com/acme/widgets/pull/12#c5" }),
              { status: 201 },
            )
          : new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("nf", { status: 404 });
    });
    try {
      const result = await callTool(env, "put", {
        contentBase64: PNG_B64,
        filename: "hero.png",
        pr: 12,
        repo: "acme/widgets",
        comment: true,
      });
      expect(result.isError).toBe(false);
      expect(result.structuredContent?.comment).toEqual({
        posted: true,
        action: "created",
        count: 1,
        commentUrl: "https://github.com/acme/widgets/pull/12#c5",
      });
      expect(result.structuredContent?.commentError).toBeUndefined();
      expect(links.rows.get("acme/widgets")).toMatchObject({
        workspace_name: WS,
        source: "comment",
      });
    } finally {
      restore();
    }
  });

  it("uploads successfully and returns an honest not_installed decline (never a tool error)", async () => {
    const { env, githubCache } = await makeEnv({ boundTo: WS });
    githubCache.store.set("ghinst:acme/widgets", { value: "none" });
    const result = await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "hero.png",
      pr: 12,
      repo: "acme/widgets",
      comment: true,
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.key).toBe("gh/acme/widgets/pull/12/hero.png");
    expect(result.structuredContent?.comment).toEqual({ posted: false, reason: "not_installed" });
  });

  it("declines not_authorized for a repo bound to a different workspace, without a GitHub write", async () => {
    const { env, githubCache } = await makeEnv({ boundTo: "other-ws" });
    githubCache.store.set("ghinst:acme/widgets", { value: "42" });
    githubCache.store.set("ghtok:42", { value: "cached-token" });
    let sawGithubCall = false;
    const restore = stubGithubFetch(() => {
      sawGithubCall = true;
      return new Response("nf", { status: 404 });
    });
    try {
      const result = await callTool(env, "put", {
        contentBase64: PNG_B64,
        filename: "hero.png",
        pr: 12,
        repo: "acme/widgets",
        comment: true,
      });
      expect(result.isError).toBe(false);
      expect(result.structuredContent?.comment).toMatchObject({
        posted: false,
        reason: "not_authorized",
      });
      expect(sawGithubCall).toBe(false);
    } finally {
      restore();
    }
  });

  it("returns a forbidden decline with fixUrl + required when the App lacks write", async () => {
    const { env, githubCache } = await makeEnv({ boundTo: WS });
    githubCache.store.set("ghinst:acme/widgets", { value: "42" });
    githubCache.store.set("ghtok:42", { value: "cached-token" });
    const restore = stubGithubFetch((url) =>
      url.includes("/issues/12/comments")
        ? new Response("no", { status: 403 })
        : new Response("nf", { status: 404 }),
    );
    try {
      const result = await callTool(env, "put", {
        contentBase64: PNG_B64,
        filename: "hero.png",
        pr: 12,
        repo: "acme/widgets",
        comment: true,
      });
      expect(result.isError).toBe(false);
      const comment = result.structuredContent?.comment as {
        posted: boolean;
        reason: string;
        fixUrl: string;
        required: string[];
      };
      expect(comment.posted).toBe(false);
      expect(comment.reason).toBe("forbidden");
      expect(comment.fixUrl).toBe(
        "https://github.com/organizations/acme/settings/installations/42/permissions/update",
      );
      expect(comment.required).toEqual(["issues:write", "pull_requests:write"]);
    } finally {
      restore();
    }
  });

  it("does not attach a comment when comment is not requested", async () => {
    const { env } = await makeEnv({ boundTo: WS });
    const result = await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "hero.png",
      pr: 12,
      repo: "acme/widgets",
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.comment).toBeUndefined();
    expect(result.structuredContent?.commentError).toBeUndefined();
  });

  it("requires files:read for comment: true — a files:write-only token is rejected before any write", async () => {
    const { env, bucket } = await makeEnv({ boundTo: WS, scopes: ["files:write"] });
    const result = await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "hero.png",
      pr: 12,
      repo: "acme/widgets",
      comment: true,
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("files:read") }]);
    // Rejected up front — no object written, not even a partial upload.
    expect(bucket.store.has("gh/acme/widgets/pull/12/hero.png")).toBe(false);
  });

  it("the same files:write-only token can still put without comment", async () => {
    const { env, bucket } = await makeEnv({ boundTo: WS, scopes: ["files:write"] });
    const result = await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "hero.png",
      pr: 12,
      repo: "acme/widgets",
    });
    expect(result.isError).toBe(false);
    expect(bucket.store.has("gh/acme/widgets/pull/12/hero.png")).toBe(true);
  });
});
