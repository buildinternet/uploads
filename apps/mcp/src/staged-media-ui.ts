import type { McpServer, McpTool } from "@buildinternet/uploads/mcp";
import { mcpOAuthRead, mcpRead, usage } from "@buildinternet/uploads/mcp";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import html from "../ui/dist/resource";
import { mediaContextProperties } from "./staged-media-response";
import { MEDIA_ICONS } from "./media-icon";

// Change this address when shipping a new UI so hosts do not reuse cached documents.
export const STAGED_MEDIA_RESOURCE = "ui://uploads/media-v3.html";
const PREVIEWLESS_RESOURCE = "ui://uploads/media-v2.html";
const LEGACY_RESOURCE = "ui://uploads/staged-media-v1.html";

/** The opener can render a scope picker without ever issuing an unscoped file read. */
export function withStagedMediaApp(tools: McpTool[], canRead: boolean): McpTool[] {
  const listing = tools.find((tool) => tool.name === "list_staged_media");
  const context = tools.find((tool) => tool.name === "resolve_media_context");
  // Ordinary tools enforce scopes in their handlers; the UI additionally needs its resource.
  if (!canRead || !listing || !context) return tools;
  return [
    ...tools,
    {
      name: "open_staged_media",
      title: "Uploads",
      icons: MEDIA_ICONS,
      description:
        "Open Uploads beside the conversation to review staged files and files attached to the current PR. Read the checkout's Git remote and branch and pass repo (owner/name), branch, and the current pr number when known. Without repo and branch, show a scope picker; never assume a checkout. Refresh keeps the displayed scope until it is changed.",
      annotations: mcpRead,
      securitySchemes: mcpOAuthRead,
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string", description: "Explicit repository as owner/name." },
          branch: { type: "string", description: "Explicit Git branch for this tray." },
          pr: {
            type: "integer",
            minimum: 1,
            description: "Current pull-request number, when known.",
          },
        },
        additionalProperties: false,
      },
      outputSchema: {
        anyOf: [
          {
            ...listing.outputSchema!,
            properties: {
              ...(listing.outputSchema!.properties as Record<string, unknown>),
              ...mediaContextProperties,
            },
            required: ["repo", "branch", "items", "cursor", "pr", "prResolution"],
          },
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
        "openai/ui": { entrypoints: [{ type: "thread" }] },
      },
      async handler(args) {
        if (args.repo === undefined && args.branch === undefined && args.pr === undefined)
          return { repo: null, branch: null, items: [], cursor: null, needsScope: true };
        if (args.repo === undefined || args.branch === undefined)
          usage("Provide both repo and branch, or neither to choose a scope.");
        const [page, resolved] = await Promise.all([
          listing.handler({ repo: args.repo, branch: args.branch }),
          context.handler(args),
        ]);
        if (!page || typeof page !== "object" || !resolved || typeof resolved !== "object")
          throw new Error("Uploads returned an invalid media context.");
        return { ...page, ...resolved };
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
  // Old chats pin the v1 tool catalog. Do not let their cached resource call v2 tools.
  for (const uri of [STAGED_MEDIA_RESOURCE, PREVIEWLESS_RESOURCE, LEGACY_RESOURCE])
    registerAppResource(
      server,
      "Uploads",
      uri,
      { mimeType: RESOURCE_MIME_TYPE, _meta: meta },
      async () => ({
        contents: [
          {
            uri,
            mimeType: RESOURCE_MIME_TYPE,
            text:
              uri === LEGACY_RESOURCE
                ? html.replace("<html", '<html data-uploads-tool-catalog="staged-v1"')
                : html,
            _meta: meta,
          },
        ],
      }),
    );
}
