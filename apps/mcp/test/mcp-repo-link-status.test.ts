/**
 * Hosted `repo_link_status` tool (issue #422): the tri-state repo<->workspace
 * binding check, mirroring `GET /github/repo-link` (apps/api/src/routes/github-link.ts)
 * via the same lenient `findRepoLink` in-process import. Covers self/other/none,
 * invalid repo grammar, and the files:read scope gate — and, critically, that
 * the "other" response never leaks the owning workspace's name anywhere in
 * the body.
 */
import { beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { sha256Hex, type WorkspaceRecord } from "@uploads/api/workspace";
import { FakeR2Bucket } from "@uploads/storage/test/fake-r2";

const TOKEN = "up_test-ws_legacy-token-value";
const WS = "test-ws";
const OTHER_WS = "owner-workspace";

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

interface RepoLinkRow {
  repo_full_name: string;
  workspace_name: string;
  installation_id: number | null;
  source: string;
  created_at: string;
}

/** In-memory `github_repo_links` stand-in — mirrors mcp-put-comment.test.ts's RepoLinksTable. */
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

/**
 * D1 fake covering just what `findRepoLink` and (for the scope test) the
 * `auth_tokens` active-token lookup need. By default the token lookup always
 * misses (legacy token path — full FILE_SCOPES). Pass `scopedToken` to
 * instead return a D1-tracked row for `TOKEN` carrying exactly those scopes.
 */
function makeDb(links: RepoLinksTable, scopedToken?: { tokenHash: string; scopes: string[] }) {
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
          return null as T;
        },
        async run() {
          return { success: true, meta: { changes: 0 }, results: [] };
        },
        async all<T>() {
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
): Promise<{ env: Env; links: RepoLinksTable }> {
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
  const scopedToken = opts.scopes ? { tokenHash, scopes: opts.scopes } : undefined;
  const env = {
    REGISTRY: { get: async (key: string) => (key === `ws:${WS}` ? record : null) },
    DB: makeDb(links, scopedToken),
    UPLOADS: bucket,
  } as unknown as Env;
  return { env, links };
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

describe("repo_link_status", () => {
  it("returns self when the repo is bound to the calling workspace", async () => {
    const { env } = await makeEnv({ boundTo: WS });
    const result = await callTool(env, "repo_link_status", { repo: "acme/widgets" });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ binding: "self" });
  });

  it("returns other when the repo is bound to a different workspace, without naming it", async () => {
    const { env } = await makeEnv({ boundTo: OTHER_WS });
    const result = await callTool(env, "repo_link_status", { repo: "acme/widgets" });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ binding: "other" });
    const raw = JSON.stringify(result);
    expect(raw).not.toContain(OTHER_WS);
    expect(Object.keys(result.structuredContent ?? {})).toEqual(["binding"]);
  });

  it("returns none when the repo is unbound", async () => {
    const { env } = await makeEnv();
    const result = await callTool(env, "repo_link_status", { repo: "acme/widgets" });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ binding: "none" });
  });

  it("usage errors on invalid repo grammar", async () => {
    const { env } = await makeEnv();
    const result = await callTool(env, "repo_link_status", { repo: "not-a-repo" });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining("repo must be owner/name") },
    ]);
  });

  it("requires files:read — a scopeless/other-scoped token is rejected", async () => {
    const { env } = await makeEnv({ boundTo: WS, scopes: ["files:write"] });
    const result = await callTool(env, "repo_link_status", { repo: "acme/widgets" });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining("requires files:read scope") },
    ]);
  });
});
