import type { McpServer, McpTool } from "@buildinternet/uploads/mcp";
import { mcpOAuthRead, mcpRead, usage } from "@buildinternet/uploads/mcp";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import html from "../ui/dist/resource";

export const STAGED_MEDIA_RESOURCE = "ui://uploads/staged-media-v1.html";

/** The opener can render a scope picker without ever issuing an unscoped file read. */
export function withStagedMediaApp(tools: McpTool[], canRead: boolean): McpTool[] {
  const listing = tools.find((tool) => tool.name === "list_staged_media");
  // Ordinary tools enforce scopes in their handlers; the UI additionally needs its resource.
  if (!canRead || !listing) return tools;
  return [
    ...tools,
    {
      name: "open_staged_media",
      title: "Staged media",
      description:
        "Open the read-only staged media tray. In a coding checkout, read its Git remote and current branch and pass repo (owner/name) and branch explicitly. Without both, show a scope picker; never assume a current checkout. Refresh keeps the displayed scope until it is changed.",
      annotations: mcpRead,
      securitySchemes: mcpOAuthRead,
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string", description: "Explicit repository as owner/name." },
          branch: { type: "string", description: "Explicit Git branch for this tray." },
        },
        additionalProperties: false,
      },
      outputSchema: {
        anyOf: [
          listing.outputSchema!,
          {
            type: "object",
            properties: {
              repo: { type: "null" },
              branch: { type: "null" },
              items: { type: "array", maxItems: 0, items: { type: "object" } },
              cursor: { type: "null" },
              needsScope: { const: true },
            },
            required: ["repo", "branch", "items", "cursor", "needsScope"],
            additionalProperties: false,
          },
        ],
      },
      _meta: {
        ui: { resourceUri: STAGED_MEDIA_RESOURCE, visibility: ["model", "app"] },
        "openai/ui": { entrypoints: [{ type: "global" }, { type: "thread" }] },
      },
      async handler(args) {
        if (args.repo === undefined && args.branch === undefined)
          return { repo: null, branch: null, items: [], cursor: null, needsScope: true };
        if (args.repo === undefined || args.branch === undefined)
          usage("Provide both repo and branch, or neither to choose a scope.");
        return listing.handler(args);
      },
    },
  ];
}

export function registerStagedMediaResource(server: McpServer): void {
  const meta = {
    ui: {
      prefersBorder: false,
      csp: {
        connectDomains: [],
        resourceDomains: ["https://embed.uploads.sh", "https://storage.uploads.sh"],
      },
    },
  };
  registerAppResource(
    server,
    "Staged media",
    STAGED_MEDIA_RESOURCE,
    { mimeType: RESOURCE_MIME_TYPE, _meta: meta },
    async () => ({
      contents: [
        { uri: STAGED_MEDIA_RESOURCE, mimeType: RESOURCE_MIME_TYPE, text: html, _meta: meta },
      ],
    }),
  );
}
