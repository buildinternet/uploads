/**
 * Hosted `put` private-repo randomized-prefix minting (issue #631, Task 7).
 * `resolveGhKeyContext`'s own decision-flow matrix lives in
 * apps/api/test/github-private-prefix-service.test.ts — this file covers
 * only the hosted MCP surface: `resolveKey` calling it in-process and
 * building the private key builder, versus the plain path staying
 * byte-identical when the repo isn't private (or the App isn't configured
 * at all).
 */
import { beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { sha256Hex, type WorkspaceRecord } from "@uploads/api/workspace";
import { FakeR2Bucket } from "@uploads/storage/test/fake-r2";

const TOKEN = "up_test-ws_legacy-token-value";
const WS = "test-ws";
const REPO = "acme/private-repo";

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

/** In-process KV fake: get/put — mirrors apps/api/test/fake-kv.ts. */
class FakeKv {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
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
  tryFirst(sql: string, args: unknown[]) {
    if (sql.includes("FROM github_repo_links WHERE repo_full_name")) {
      const [repo] = args as [string];
      return this.rows.get(repo) ?? null;
    }
    return undefined;
  }
}

interface PrefixRow {
  repo_full_name: string;
  branch: string;
  prefix_id: string;
  rotated_at: string | null;
}

/** In-memory `github_private_prefixes` stand-in — mirrors apps/api/test/helpers/fake-private-prefixes-table.ts. */
class PrivatePrefixesTable {
  readonly rows: PrefixRow[] = [];
  tryFirst(sql: string, args: unknown[]) {
    if (sql.includes("FROM github_private_prefixes") && sql.includes("rotated_at IS NULL")) {
      const [repo, branch] = args as [string, string];
      const row = this.rows.find(
        (r) => r.repo_full_name === repo && r.branch === branch && r.rotated_at === null,
      );
      return row ? ({ prefix_id: row.prefix_id } as unknown) : null;
    }
    return undefined;
  }
  tryRun(sql: string, args: unknown[]) {
    if (sql.startsWith("INSERT OR IGNORE INTO github_private_prefixes")) {
      const [repo, branch, prefixId, createdAt] = args as [string, string, string, string];
      const exists = this.rows.some(
        (r) => r.repo_full_name === repo && r.branch === branch && r.rotated_at === null,
      );
      if (!exists) {
        this.rows.push({ repo_full_name: repo, branch, prefix_id: prefixId, rotated_at: null });
      }
      return { success: true, meta: { changes: exists ? 0 : 1 }, results: [] };
    }
    return undefined;
  }
}

/** Minimal file_metadata + github_repo_links + github_private_prefixes D1 fake. */
function makeDb(
  links: RepoLinksTable,
  prefixes: PrivatePrefixesTable,
  metadata: Map<string, Map<string, string>>,
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
          if (normalized.includes("github_private_prefixes")) {
            return (prefixes.tryFirst(normalized, values) ?? null) as T;
          }
          // auth_tokens active-token lookup: always miss (legacy token path).
          return null as T;
        },
        async run() {
          if (normalized.includes("github_private_prefixes")) {
            return (
              prefixes.tryRun(normalized, values) ?? {
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
  opts: {
    appConfigured?: boolean;
    installed?: boolean;
    private?: boolean;
    prHeadBranch?: string;
  } = {},
): Promise<{ env: Env; links: RepoLinksTable; prefixes: PrivatePrefixesTable }> {
  const tokenHash = await sha256Hex(TOKEN);
  const record: WorkspaceRecord = {
    provider: "r2",
    bucket: "test-bucket",
    binding: "UPLOADS",
    publicBaseUrl: "https://storage.example.com",
    tokenHash,
  };
  const links = new RepoLinksTable();
  // Bound to this workspace: checkRepoAuthorization's fast "already mine"
  // path, so the test doesn't also need to fake the entitlement/claim fetch.
  links.rows.set(REPO, {
    repo_full_name: REPO,
    workspace_name: WS,
    installation_id: 42,
    source: "test",
    created_at: new Date().toISOString(),
  });
  const prefixes = new PrivatePrefixesTable();
  const metadata = new Map<string, Map<string, string>>();
  const githubCache = new FakeKv();
  if (opts.installed !== false) githubCache.store.set(`ghinst:${REPO}`, "42");
  if (opts.private !== undefined) {
    githubCache.store.set(`ghpriv:${REPO}`, opts.private ? "1" : "0");
  }
  if (opts.prHeadBranch) githubCache.store.set(`prhead:${REPO}#12`, opts.prHeadBranch);
  const env = {
    REGISTRY: { get: async (key: string) => (key === `ws:${WS}` ? record : null) },
    DB: makeDb(links, prefixes, metadata),
    UPLOADS: new FakeR2Bucket(),
    GITHUB_CACHE: githubCache,
    ...(opts.appConfigured === false ? {} : GITHUB_APP_CFG_ENV),
  } as unknown as Env;
  return { env, links, prefixes };
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
    result: { isError: boolean; structuredContent?: Record<string, unknown>; content: unknown[] };
  };
  return body.result;
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG_B64 = btoa(String.fromCharCode(...PNG_BYTES));

describe("hosted put private-prefix mode (issue #631)", () => {
  it("mints a randomized private key + embed URL for a private repo's PR target", async () => {
    const { env, prefixes } = await makeEnv({ private: true, prHeadBranch: "feature/thing" });
    const result = await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "hero.png",
      pr: 12,
      repo: REPO,
    });
    expect(result.isError).toBe(false);
    expect(prefixes.rows).toHaveLength(1);
    const prefixId = prefixes.rows[0]!.prefix_id;
    expect(prefixId).toMatch(/^[0-9a-f]{32}$/);
    expect(result.structuredContent).toMatchObject({
      key: `gh/private/${prefixId}/pull/12/hero.png`,
      url: `https://storage.example.com/gh/private/${prefixId}/pull/12/hero.png`,
    });
  });

  it("leaves a public repo's key unchanged (plain gh/ layout)", async () => {
    const { env, prefixes } = await makeEnv({ private: false });
    const result = await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "hero.png",
      issue: 7,
      repo: REPO,
    });
    expect(result.isError).toBe(false);
    expect(prefixes.rows).toHaveLength(0);
    expect(result.structuredContent).toMatchObject({
      key: `gh/${REPO}/issues/7/hero.png`,
    });
  });

  it("degrades to the exact pre-#631 plain key when the GitHub App isn't configured at all", async () => {
    const { env, prefixes } = await makeEnv({ appConfigured: false });
    const result = await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "hero.png",
      issue: 7,
      repo: REPO,
    });
    expect(result.isError).toBe(false);
    expect(prefixes.rows).toHaveLength(0);
    expect(result.structuredContent).toMatchObject({
      key: `gh/${REPO}/issues/7/hero.png`,
    });
  });
});
