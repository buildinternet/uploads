/**
 * Hosted MCP branch staging (`put` + `branch`) and promote (`promote` tool,
 * plus `put` with `pr` + `branch` promote-after).
 */
import { beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { sha256Hex, type WorkspaceRecord } from "@uploads/api/workspace";
import { FakeR2Bucket } from "@uploads/storage/test/fake-r2";

const TOKEN = "up_test-ws_legacy-token-value";
const WS = "test-ws";

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

function makeDb(links: RepoLinksTable, metadata: Map<string, Map<string, string>>) {
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
            // DELETE can be full-key or selective; promote's set path uses full replace.
            if (values.length === 2) metadata.delete(scopeKey(ws, objectKey));
          }
          return { success: true, meta: { changes: 0 }, results: [] };
        },
        async all<T>() {
          // getFileMetadata shape
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
          // getMetadataForKeys: SELECT object_key, meta_key, meta_value …
          // WHERE workspace = ? AND object_key IN (…optional meta_key filter)
          if (normalized.includes("SELECT object_key, meta_key, meta_value FROM file_metadata")) {
            const [ws, ...rest] = values as string[];
            // Bound object keys always contain '/' (gh/… or screenshots/…).
            const objectKeys = rest.filter((k) => k.includes("/"));
            const results: { object_key: string; meta_key: string; meta_value: string }[] = [];
            for (const objectKey of objectKeys) {
              const map = metadata.get(scopeKey(ws, objectKey));
              if (!map) continue;
              for (const [meta_key, meta_value] of map) {
                results.push({ object_key: objectKey, meta_key, meta_value });
              }
            }
            return { success: true, results: results as T[], meta: {} };
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

async function makeEnv(opts: { boundTo?: string } = {}) {
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
  const env = {
    REGISTRY: { get: async (key: string) => (key === `ws:${WS}` ? record : null) },
    DB: makeDb(links, metadata),
    UPLOADS: bucket,
    GITHUB_CACHE: githubCache,
    ...GITHUB_APP_CFG_ENV,
  } as unknown as Env;
  return { env, bucket, links, metadata, githubCache };
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
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
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

describe("hosted put: branch staging", () => {
  it("stages under gh/…/branch/… with gh.status=staged metadata", async () => {
    const { env, bucket, metadata } = await makeEnv();
    const result = await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "hero.png",
      branch: "feature/x",
      repo: "acme/widgets",
      state: "after",
    });
    expect(result.isError).toBe(false);
    // feature/x sanitizes to feature-x in the key segment.
    expect(result.structuredContent).toMatchObject({
      key: "gh/acme/widgets/branch/feature-x/hero.png",
      url: "https://storage.example.com/gh/acme/widgets/branch/feature-x/hero.png",
    });
    expect(bucket.store.has("gh/acme/widgets/branch/feature-x/hero.png")).toBe(true);
    const meta = metadata.get(`${WS} gh/acme/widgets/branch/feature-x/hero.png`);
    expect(meta?.get("gh.kind")).toBe("branch");
    expect(meta?.get("gh.status")).toBe("staged");
    expect(meta?.get("gh.branch")).toBe("feature/x");
    expect(meta?.get("gh.repo")).toBe("acme/widgets");
    expect(meta?.get("state")).toBe("after");
  });

  it("usage errors: branch without repo", async () => {
    const { env } = await makeEnv();
    const result = await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "hero.png",
      branch: "main",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining("repo is required with branch") },
    ]);
  });

  it("usage errors: branch + issue", async () => {
    const { env } = await makeEnv();
    const result = await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "hero.png",
      branch: "main",
      issue: 7,
      repo: "acme/widgets",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining("branch cannot be combined with issue"),
      },
    ]);
  });

  it("usage errors: branch + key", async () => {
    const { env } = await makeEnv();
    const result = await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "hero.png",
      branch: "main",
      repo: "acme/widgets",
      key: "shots/hero.png",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining("key cannot be combined with branch") },
    ]);
  });

  it("multi-file stages each under the branch prefix", async () => {
    const { env, bucket } = await makeEnv();
    const result = await callTool(env, "put", {
      files: [
        { filename: "before.png", contentBase64: PNG_B64 },
        { filename: "after.png", contentBase64: PNG_B64 },
      ],
      branch: "feat",
      repo: "acme/widgets",
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      uploads: expect.arrayContaining([
        expect.objectContaining({ key: "gh/acme/widgets/branch/feat/before.png" }),
        expect.objectContaining({ key: "gh/acme/widgets/branch/feat/after.png" }),
      ]),
      failures: [],
    });
    expect(bucket.store.has("gh/acme/widgets/branch/feat/before.png")).toBe(true);
    expect(bucket.store.has("gh/acme/widgets/branch/feat/after.png")).toBe(true);
  });
});

describe("hosted promote tool", () => {
  it("copies staged files into the PR prefix", async () => {
    const { env, bucket } = await makeEnv({ boundTo: WS });
    const staged = await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "hero.png",
      branch: "feat",
      repo: "acme/widgets",
    });
    expect(staged.isError).toBe(false);

    const result = await callTool(env, "promote", {
      repo: "acme/widgets",
      pr: 12,
      branch: "feat",
      comment: false,
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      promotion: {
        promoted: ["gh/acme/widgets/pull/12/hero.png"],
        skipped: [],
      },
    });
    expect(bucket.store.has("gh/acme/widgets/pull/12/hero.png")).toBe(true);
    // Original staged object is kept.
    expect(bucket.store.has("gh/acme/widgets/branch/feat/hero.png")).toBe(true);
  });

  it("returns empty promoted when nothing is staged", async () => {
    const { env } = await makeEnv({ boundTo: WS });
    const result = await callTool(env, "promote", {
      repo: "acme/widgets",
      pr: 12,
      branch: "empty-branch",
      comment: false,
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      promotion: { promoted: [], skipped: [] },
    });
  });

  it("usage errors: missing branch", async () => {
    const { env } = await makeEnv();
    const result = await callTool(env, "promote", {
      repo: "acme/widgets",
      pr: 12,
    });
    expect(result.isError).toBe(true);
    // Schema required-property check fires before the handler.
    expect(result.content).toEqual([
      {
        type: "text",
        text: expect.stringMatching(/required property ["']branch["']|branch is required/),
      },
    ]);
  });

  it("refreshes the managed comment after promote by default", async () => {
    const { env, githubCache } = await makeEnv({ boundTo: WS });
    githubCache.store.set("ghinst:acme/widgets", { value: "42" });
    githubCache.store.set("ghtok:42", { value: "cached-token" });

    await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "hero.png",
      branch: "feat",
      repo: "acme/widgets",
    });

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
      const result = await callTool(env, "promote", {
        repo: "acme/widgets",
        pr: 12,
        branch: "feat",
      });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        promotion: {
          promoted: ["gh/acme/widgets/pull/12/hero.png"],
        },
        comment: expect.objectContaining({ posted: true }),
      });
    } finally {
      restore();
    }
  });
});

describe("hosted put: pr + branch promote-after", () => {
  it("uploads to the PR key and promotes staged files from that branch", async () => {
    const { env, bucket, githubCache } = await makeEnv({ boundTo: WS });
    githubCache.store.set("ghinst:acme/widgets", { value: "42" });
    githubCache.store.set("ghtok:42", { value: "cached-token" });

    // Stage first.
    await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "staged.png",
      branch: "feat",
      repo: "acme/widgets",
    });

    const restore = stubGithubFetch((url, init) => {
      if (url.includes("/issues/12/comments")) {
        return init.method === "POST"
          ? new Response(
              JSON.stringify({ id: 9, html_url: "https://github.com/acme/widgets/pull/12#c9" }),
              { status: 201 },
            )
          : new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("nf", { status: 404 });
    });
    try {
      const result = await callTool(env, "put", {
        contentBase64: PNG_B64,
        filename: "new.png",
        pr: 12,
        branch: "feat",
        repo: "acme/widgets",
      });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        key: "gh/acme/widgets/pull/12/new.png",
        promotion: {
          promoted: expect.arrayContaining(["gh/acme/widgets/pull/12/staged.png"]),
        },
        comment: expect.objectContaining({ posted: true }),
      });
      expect(bucket.store.has("gh/acme/widgets/pull/12/new.png")).toBe(true);
      expect(bucket.store.has("gh/acme/widgets/pull/12/staged.png")).toBe(true);
    } finally {
      restore();
    }
  });
});
