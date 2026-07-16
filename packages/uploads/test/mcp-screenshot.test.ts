import { describe, expect, it, vi } from "vitest";
import type { UploadsClient } from "../src/client.js";
import type { UploadsClientConfig } from "../src/config.js";
import { createMcpServer, type McpServer } from "../src/mcp/server.js";
import { createUploadsMcpTools } from "../src/mcp/tools.js";

// The screenshot tool dynamically imports "../screenshot.js" from inside its
// handler (by design — keeps mcp/tools.ts free of a static reference to the
// local-backend chain). Mock captureScreenshot there so this test never
// launches a browser or hits the network, while keeping the real parsers.
vi.mock("../src/screenshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/screenshot.js")>();
  return {
    ...actual,
    captureScreenshot: vi.fn(async () => ({
      png: new Uint8Array([1, 2, 3]),
      filename: "example-com.png",
      backend: "remote" as const,
    })),
  };
});

function fakeClient(): UploadsClient {
  return {
    put: async (body: Uint8Array, opts: { filename: string; key?: string }) => ({
      workspace: "test",
      key: opts.key ?? "screenshots/misc/generated.png",
      url: `https://x.test/${opts.key ?? "screenshots/misc/generated.png"}`,
      embedUrl: null,
      size: body.byteLength,
      contentType: "image/png",
    }),
    list: async () => ({ items: [], cursor: null }),
    health: async () => ({ ok: true }),
  } as unknown as UploadsClient;
}

function serverWith() {
  const client = fakeClient();
  const server = createMcpServer({
    serverInfo: { name: "uploads", version: "0.0.0-test" },
    tools: createUploadsMcpTools({
      globals: { apiUrl: "https://x.test", token: "up_test_x" },
      clientFactory: (_config: UploadsClientConfig) => client,
    }),
  });
  return { server };
}

async function rpc(server: McpServer, method: string, params?: unknown, id: number | string = 1) {
  const raw = await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  return raw === undefined ? undefined : JSON.parse(raw);
}

describe("mcp screenshot tool", () => {
  it("is listed in tools/list", async () => {
    const { server } = serverWith();
    const res = await rpc(server, "tools/list");
    // oxlint-disable-next-line no-explicit-any
    const tools = res.result.tools as Array<any>;
    expect(tools.some((t) => t.name === "screenshot")).toBe(true);
  });

  it("captures (mocked) and uploads, returning url + markdown", async () => {
    const { server } = serverWith();
    const res = await rpc(server, "tools/call", {
      name: "screenshot",
      arguments: { target: "https://example.com" },
    });
    expect(res.result.isError).toBe(false);
    const content = res.result.structuredContent as {
      url: string;
      markdown: string;
      backend: string;
    };
    expect(content.backend).toBe("remote");
    expect(content.url).toContain("https://x.test/");
    expect(content.markdown).toContain("![");
  });

  it("rejects a missing target as a tool error", async () => {
    const { server } = serverWith();
    const res = await rpc(server, "tools/call", { name: "screenshot", arguments: {} });
    expect(res.result.isError).toBe(true);
  });

  it("rejects an invalid via value", async () => {
    const { server } = serverWith();
    const res = await rpc(server, "tools/call", {
      name: "screenshot",
      arguments: { target: "https://example.com", via: "carrier-pigeon" },
    });
    expect(res.result.isError).toBe(true);
  });
});
