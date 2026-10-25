import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { createMcpServer, mcpOAuthRead, mcpRead, type McpTool } from "@buildinternet/uploads/mcp";
import { rpc, legacyRpc, validator } from "../../../packages/uploads/test/mcp-harness";
import {
  registerStagedMediaResource,
  STAGED_MEDIA_RESOURCE,
  withStagedMediaApp,
} from "../src/staged-media-ui";

function fixture(canRead = true) {
  const handler = vi.fn(async (args: Record<string, unknown>) => ({
    ...args,
    items: [],
    cursor: null,
  }));
  const listing: McpTool = {
    name: "list_staged_media",
    title: "Staged media",
    description: "Read scoped media",
    annotations: mcpRead,
    securitySchemes: mcpOAuthRead,
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string" }, branch: { type: "string" } },
      required: ["repo", "branch"],
    },
    outputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        branch: { type: "string" },
        items: { type: "array", items: {} },
        cursor: { type: "null" },
      },
      required: ["repo", "branch", "items", "cursor"],
    },
    handler,
  };
  const server = createMcpServer({
    serverInfo: { name: "tray-test", version: "1" },
    validator,
    tools: withStagedMediaApp(
      [
        listing,
        {
          name: "resolve_media_context",
          title: "Resolve media context",
          description: "Resolve the displayed PR",
          annotations: mcpRead,
          securitySchemes: mcpOAuthRead,
          inputSchema: { type: "object" },
          handler: async (args) => ({
            repo: args.repo,
            branch: args.branch,
            pr: args.pr ?? null,
            prResolution: args.pr ? "explicit" : "unavailable",
          }),
        },
      ],
      canRead,
    ),
  });
  if (canRead) registerStagedMediaResource(server);
  return { server, handler };
}

describe("staged media MCP App", () => {
  it("opens an unscoped picker without reading files and delegates explicit scopes", async () => {
    const { server, handler } = fixture();
    const empty = await rpc(server, "tools/call", { name: "open_staged_media", arguments: {} });
    expect(empty.result.structuredContent).toMatchObject({
      needsScope: true,
      repo: null,
      branch: null,
      items: [],
    });
    expect(handler).not.toHaveBeenCalled();
    const partial = await rpc(fixture().server, "tools/call", {
      name: "open_staged_media",
      arguments: { repo: "owner/repo" },
    });
    expect(partial.result.isError).toBe(true);
    const scoped = fixture();
    await rpc(scoped.server, "tools/call", {
      name: "open_staged_media",
      arguments: { repo: "owner/repo", branch: "feature/a" },
    });
    expect(scoped.handler).toHaveBeenCalledWith({ repo: "owner/repo", branch: "feature/a" });
    for (const call of [rpc, legacyRpc]) {
      const result = await call(fixture().server, "tools/call", {
        name: "open_staged_media",
        arguments: { repo: "owner/repo", branch: "feature/a", pr: 42 },
      });
      expect(result.result.structuredContent).toEqual({
        repo: "owner/repo",
        branch: "feature/a",
        pr: 42,
        prResolution: "explicit",
        items: [],
        cursor: null,
      });
    }
  });

  it("advertises authenticated UI linkage and serves the bundled resource on both protocols", async () => {
    const listed = await rpc(fixture().server, "tools/list");
    const opener = listed.result.tools.find(
      (t: { name: string }) => t.name === "open_staged_media",
    );
    expect(opener._meta).toMatchObject({
      securitySchemes: mcpOAuthRead,
      ui: { resourceUri: STAGED_MEDIA_RESOURCE },
    });
    for (const call of [rpc, legacyRpc]) {
      const tools = await call(fixture().server, "tools/list");
      expect(
        tools.result.tools.find((tool: { name: string }) => tool.name === "open_staged_media")
          .title,
      ).toBe("Uploads");
      expect(
        tools.result.tools.find((tool: { name: string }) => tool.name === "open_staged_media")
          ._meta["openai/ui"].entrypoints,
      ).toEqual([{ type: "thread" }]);
      expect(
        tools.result.tools.find((tool: { name: string }) => tool.name === "open_staged_media")
          .icons,
      ).toEqual([
        {
          src: `data:image/png;base64,${readFileSync(new NodeURL("../../web/public/apple-touch-icon.png", import.meta.url)).toString("base64")}`,
          mimeType: "image/png",
          sizes: ["180x180"],
        },
      ]);
      const resources = await call(fixture().server, "resources/list");
      expect(resources.result.resources[0].uri).toBe(STAGED_MEDIA_RESOURCE);
      const read = await call(fixture().server, "resources/read", { uri: STAGED_MEDIA_RESOURCE });
      expect(read.error, JSON.stringify(read)).toBeUndefined();
      const resource = read.result.contents[0];
      expect(resource.mimeType).toBe("text/html;profile=mcp-app");
      expect(resource.text).toContain("<html");
      expect(resource._meta.ui.csp).toEqual({
        connectDomains: [],
        resourceDomains: ["https://embed.uploads.sh", "https://storage.uploads.sh"],
      });
    }
  });

  it("does not advertise a tray opener without read permission", async () => {
    const result = await rpc(fixture(false).server, "tools/list");
    expect(result.result.tools.map((t: { name: string }) => t.name)).not.toContain(
      "open_staged_media",
    );
  });
});
