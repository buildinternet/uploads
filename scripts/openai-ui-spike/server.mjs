import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import {
  toNodeHandler,
  localhostHostValidation,
  localhostOriginValidation,
} from "@modelcontextprotocol/node";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";

export const resourceUri = "ui://uploads-spike/staged-media-v1.html";
export const toolName = "show_staged_media_demo";
export const inputSchema = z
  .object({ scenario: z.enum(["populated", "empty", "error"]).default("populated") })
  .strict();
const fileSchema = z.object({
  id: z.enum(["before", "after"]),
  filename: z.string(),
  state: z.enum(["before", "after"]),
  path: z.string(),
});
const outputSchema = z.object({
  demo: z.literal(true),
  workspace: z.string(),
  repo: z.string(),
  branch: z.string(),
  scenario: z.enum(["populated", "empty"]),
  files: z.array(fileSchema),
});

export function fixtureResult(scenario = "populated") {
  if (scenario === "error")
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "Simulated read failure. Choose Populated or Empty to recover. No uploads service was contacted.",
        },
      ],
    };
  const data = {
    demo: true,
    workspace: "demo-workspace",
    repo: "example/studio",
    branch: "settings-refresh",
    scenario,
    files:
      scenario === "empty"
        ? []
        : [
            { id: "before", filename: "settings-before.png", state: "before", path: "/settings" },
            { id: "after", filename: "settings-after.png", state: "after", path: "/settings" },
          ],
  };
  return {
    content: [
      {
        type: "text",
        text: `Synthetic demo only: ${data.files.length} staged images for ${data.repo}, branch ${data.branch}. No real workspace was read.`,
      },
    ],
    structuredContent: data,
  };
}

export function createFixtureServer() {
  const server = new McpServer({ name: "uploads-ui-compatibility-spike", version: "0.0.0" });
  registerAppTool(
    server,
    toolName,
    {
      title: "Staged media demo",
      description:
        "Open a read-only gallery of synthetic before/after screenshots. Compatibility test only; never accesses uploads.sh accounts or files. Choose populated, empty, or simulated error.",
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: {
        securitySchemes: [{ type: "noauth" }],
        ui: { resourceUri, visibility: ["model", "app"] },
        "openai/ui": { entrypoints: [{ type: "global" }, { type: "thread" }] },
      },
    },
    async ({ scenario }) => fixtureResult(scenario),
  );
  const meta = { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } };
  registerAppResource(
    server,
    "Staged media demo",
    resourceUri,
    { mimeType: RESOURCE_MIME_TYPE, _meta: meta },
    async () => {
      if (process.env.SPIKE_TRACE === "1") console.log("resources/read: gallery");
      return {
        contents: [
          {
            uri: resourceUri,
            mimeType: RESOURCE_MIME_TYPE,
            text: await readFile(new URL("./dist/gallery.html", import.meta.url), "utf8"),
            _meta: meta,
          },
        ],
      };
    },
  );
  return server;
}

export async function startServer(port = 4319) {
  const handler = createMcpHandler(createFixtureServer, {
    legacy: "stateless",
    maxRequestBodySize: 16 * 1024,
  });
  const serveMcp = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const http = createHttpServer((req, res) => {
    void handleRequest(req, res);
  });
  async function handleRequest(req, res) {
    // Opt-in transport diagnostics exclude headers, request bodies, and query strings.
    if (process.env.SPIKE_TRACE === "1") {
      const started = Date.now();
      res.once("finish", () => {
        console.log(
          `${req.method} ${req.url?.split("?")[0]} ${res.statusCode} ${Date.now() - started}ms`,
        );
      });
    }
    try {
      if (!validateHost(req, res) || !validateOrigin(req, res)) return;
      const path = new URL(req.url, "http://localhost").pathname;
      if (path === "/mcp") return await serveMcp(req, res);
      const pages = { "/": "harness.html", "/gallery": "gallery.html" };
      if (req.method !== "GET" || !Object.hasOwn(pages, path)) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(await readFile(new URL(`./dist/${pages[path]}`, import.meta.url)));
    } catch (error) {
      console.error(error.message);
      if (!res.headersSent) res.writeHead(500);
      res.end("Fixture server error");
    }
  }
  await new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, "127.0.0.1", resolve);
  });
  return {
    port: http.address().port,
    close: async () => {
      await handler.close();
      await new Promise((resolve) => http.close(resolve));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startServer();
  console.log(
    `Fixture-only MCP: http://127.0.0.1:${server.port}/mcp\nLocal SDK harness: http://127.0.0.1:${server.port}/`,
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      void server.close().then(
        () => process.exit(0),
        (error) => {
          console.error(error);
          process.exit(1);
        },
      );
    });
}
