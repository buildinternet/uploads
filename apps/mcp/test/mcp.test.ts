import { beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { sha256Hex, type WorkspaceRecord } from "@uploads/api/workspace";
import { FakeR2Bucket } from "@uploads/storage/test/fake-r2";

const TOKEN = "up_test-ws_legacy-token-value";

const workspace: WorkspaceRecord = {
  provider: "r2",
  bucket: "test-bucket",
  binding: "UPLOADS",
  publicBaseUrl: "https://storage.example.com",
};

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

/**
 * Fake bindings following apps/api/test/routes-auth.test.ts: KV returns the
 * workspace record (only for the test-ws key), D1 returns a token row only
 * when configured AND the query is bound to test-ws (otherwise the legacy KV
 * token-hash path authenticates), R2 is an in-memory bucket. WRITE_LIMITER is
 * only bound when `rateLimitOk` is set, so most tests exercise the fail-open
 * path (mirrors apps/api/test/routes-files.test.ts).
 */
async function makeEnv(
  options: { d1?: { tokenHash: string; scopes: string }; rateLimitOk?: boolean } = {},
): Promise<{ env: Env; bucket: FakeR2Bucket }> {
  const record: WorkspaceRecord = { ...workspace, tokenHash: await sha256Hex(TOKEN) };
  const bucket = new FakeR2Bucket();
  const env = {
    REGISTRY: {
      get: async (key: string) => (key === "ws:test-ws" ? record : null),
      put: async () => undefined,
    },
    DB: {
      prepare: () => {
        let values: unknown[] = [];
        return {
          bind(...next: unknown[]) {
            values = next;
            return this;
          },
          async first() {
            const [ws, hash] = values as string[];
            const token = options.d1;
            if (ws === "test-ws" && token && token.tokenHash === hash) {
              return {
                id: "token-id",
                workspace: "test-ws",
                token_hash: token.tokenHash,
                label: null,
                scopes: token.scopes,
                created_at: "2026-07-10T00:00:00.000Z",
                expires_at: null,
                revoked_at: null,
              };
            }
            return null;
          },
        };
      },
    },
    UPLOADS: bucket,
    ...(options.rateLimitOk === undefined
      ? {}
      : { WRITE_LIMITER: { limit: async () => ({ success: options.rateLimitOk }) } }),
  } as unknown as Env;
  return { env, bucket };
}

async function rpc(
  env: Env,
  body: unknown,
  token = TOKEN,
  path = "/test-ws/mcp",
): Promise<Response> {
  return app.request(
    path,
    {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { Authorization: `Bearer ${token}` },
    },
    env,
  );
}

async function callTool(env: Env, name: string, args: Record<string, unknown>, token = TOKEN) {
  const response = await rpc(
    env,
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    token,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    result: { isError: boolean; structuredContent?: Record<string, unknown>; content: unknown[] };
  };
  return body.result;
}

// A sniffable payload: the 8-byte PNG signature plus 3 filler bytes — 11 bytes.
// putObject sniffs the stored content type from these bytes (guards.ts).
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG_B64 = btoa(String.fromCharCode(...PNG_BYTES));

describe("mcp worker", () => {
  it("rejects a wrong token with a uniform 401 before any MCP handling", async () => {
    const { env } = await makeEnv();
    const response = await rpc(env, { jsonrpc: "2.0", id: 1, method: "initialize" }, "wrong");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("answers the initialize handshake", async () => {
    const { env } = await makeEnv();
    const response = await rpc(env, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    const body = (await response.json()) as {
      result: { protocolVersion: string; serverInfo: { name: string } };
    };
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.serverInfo.name).toBe("uploads-mcp");
  });

  it("lists exactly the remote tools", async () => {
    const { env } = await makeEnv();
    const response = await rpc(env, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const body = (await response.json()) as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((tool) => tool.name).sort()).toEqual([
      "delete",
      "health",
      "list",
      "put",
    ]);
  });

  it("uploads base64 content and returns url + markdown", async () => {
    const { env, bucket } = await makeEnv();
    const result = await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "shot.png",
      key: "shots/shot.png",
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      workspace: "test-ws",
      key: "shots/shot.png",
      url: "https://storage.example.com/shots/shot.png",
      size: 11,
      contentType: "image/png",
      markdown: "![shot.png](https://storage.example.com/shots/shot.png)",
    });
    expect(bucket.store.has("shots/shot.png")).toBe(true);
    expect(bucket.store.get("shots/shot.png")?.data).toEqual(PNG_BYTES);
    expect(bucket.store.get("shots/shot.png")?.contentType).toBe("image/png");
  });

  it("computes the default screenshot key without git derivation", async () => {
    const { env, bucket } = await makeEnv();
    const result = await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "shot.png",
      repo: "acme/site",
      ref: "pr-7",
    });
    expect(result.isError).toBe(false);
    const key = result.structuredContent?.key as string;
    expect(key).toMatch(/^screenshots\/acme-site\/pr-7\/shot-[0-9a-f]{6}\.png$/);
    expect(bucket.store.has(key)).toBe(true);
  });

  it("lists uploaded objects with public urls, then deletes them", async () => {
    const { env, bucket } = await makeEnv();
    await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "shot.png",
      key: "shots/shot.png",
    });

    const listed = await callTool(env, "list", { prefix: "shots/" });
    expect(listed.isError).toBe(false);
    const items = listed.structuredContent?.items as { key: string; url: string }[];
    expect(items).toHaveLength(1);
    expect(items[0].key).toBe("shots/shot.png");
    expect(items[0].url).toBe("https://storage.example.com/shots/shot.png");

    const deleted = await callTool(env, "delete", { key: "shots/shot.png" });
    expect(deleted.isError).toBe(false);
    expect(deleted.structuredContent).toEqual({ key: "shots/shot.png", deleted: true });
    expect(bucket.store.size).toBe(0);
  });

  it("enforces token scopes inside tool handlers", async () => {
    const token = "up_test-ws_read-only-token";
    const { env, bucket } = await makeEnv({
      d1: { tokenHash: await sha256Hex(token), scopes: JSON.stringify(["files:read"]) },
    });
    const result = await callTool(
      env,
      "put",
      { contentBase64: PNG_B64, filename: "shot.png" },
      token,
    );
    expect(result.isError).toBe(true);
    // The shared usage() helper throws UploadsError, whose code the server
    // core appends to the tool error text.
    expect(result.content).toEqual([
      { type: "text", text: "forbidden: requires files:write scope" },
    ]);
    expect(bucket.store.size).toBe(0);

    const listed = await callTool(env, "list", {}, token);
    expect(listed.isError).toBe(false);
  });

  it("rejects an invalid explicit key as a tool error", async () => {
    const { env } = await makeEnv();
    const result = await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "shot.png",
      key: "../escape.png",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "invalid key" }]);
  });

  it("rejects unsupported bytes as a tool error (sniffed, not filename-trusted)", async () => {
    const { env, bucket } = await makeEnv();
    const result = await callTool(env, "put", {
      contentBase64: btoa("just some plain text"),
      filename: "shot.png",
      key: "shots/shot.png",
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("unsupported media type");
    expect(bucket.store.size).toBe(0);
  });

  it("rejects put with a rate-limit tool error when the write budget is spent", async () => {
    const { env, bucket } = await makeEnv({ rateLimitOk: false });
    const result = await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "shot.png",
      key: "shots/shot.png",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "rate limit exceeded" }]);
    expect(bucket.store.size).toBe(0);
  });

  it("uploads when the WRITE_LIMITER binding allows the write", async () => {
    const { env, bucket } = await makeEnv({ rateLimitOk: true });
    const result = await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "shot.png",
      key: "shots/shot.png",
    });
    expect(result.isError).toBe(false);
    expect(bucket.store.has("shots/shot.png")).toBe(true);
  });

  it("rejects the same token against a different workspace path with 401", async () => {
    const { env } = await makeEnv();
    for (const path of ["/default/mcp", "/other-ws/mcp"]) {
      const response = await rpc(env, { jsonrpc: "2.0", id: 1, method: "initialize" }, TOKEN, path);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
  });

  it("answers health without a scope", async () => {
    const { env } = await makeEnv();
    const result = await callTool(env, "health", {});
    expect(result.structuredContent).toEqual({ ok: true });
  });

  it("returns 202 with an empty body for notifications", async () => {
    const { env } = await makeEnv();
    const response = await rpc(env, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("rejects GET and DELETE on the endpoint (stateless: no SSE, no sessions)", async () => {
    const { env } = await makeEnv();
    for (const method of ["GET", "DELETE"]) {
      const response = await app.request(
        "/test-ws/mcp",
        { method, headers: { Authorization: `Bearer ${TOKEN}` } },
        env,
      );
      expect(response.status).toBe(405);
      expect(await response.json()).toEqual({ error: "method not allowed" });
    }
  });

  it("rejects a JSON array body with -32600 (batching removed from MCP)", async () => {
    const { env } = await makeEnv();
    const response = await rpc(env, [{ jsonrpc: "2.0", id: 1, method: "ping" }]);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32600);
  });
});
