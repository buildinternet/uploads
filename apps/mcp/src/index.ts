/**
 * Remote MCP server for uploads.sh — a standalone worker on agents.uploads.sh (alternate: mcp.uploads.sh).
 *
 * Stateless MCP Streamable HTTP: each POST carries one JSON-RPC message and
 * gets its response (or 202 for notifications) in the same HTTP exchange. No
 * sessions and no SSE stream — spec-compliant for a stateless server, so
 * GET/DELETE on the endpoint are 405. Auth is the REST API's per-workspace
 * bearer-token middleware; the protocol core is the CLI package's
 * `createMcpServer`, shared verbatim.
 */
import { createMcpServer } from "@buildinternet/uploads/mcp";
import { AppError, isAppError, MethodNotAllowedError, NotFoundError } from "@uploads/errors";
import { tokenWorkspaceAuth, workspaceAuth, type WorkspaceVars } from "@uploads/api/workspace";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import pkg from "../package.json";
import { createRemoteTools } from "./tools";

async function handleMcp(c: Context<WorkspaceVars>): Promise<Response> {
  const body = await c.req.text();
  const server = createMcpServer({
    serverInfo: { name: "uploads-mcp", version: pkg.version },
    tools: createRemoteTools({
      env: c.env,
      workspace: c.get("workspace"),
      workspaceName: c.get("workspaceName"),
      authScopes: c.get("authScopes"),
    }),
  });
  const result = await server.handleLine(body);
  // Notifications and client responses get no JSON-RPC reply: 202, empty.
  if (result === undefined) return c.body(null, 202);
  return c.body(result, 200, { "Content-Type": "application/json" });
}

function respondError(c: Context, err: unknown): Response {
  const appErr = isAppError(err) ? err : AppError.from(err);
  if (!appErr.expose || appErr.type === "internal") {
    console.error(
      JSON.stringify({
        message: appErr.message,
        code: appErr.code,
        type: appErr.type,
        stack: appErr.stack,
      }),
    );
  }
  return c.json(appErr.toWire(), appErr.status as ContentfulStatusCode);
}

const methodNotAllowed = (_c: Context<WorkspaceVars>) => {
  throw new MethodNotAllowedError();
};

/** SEP-1649-style discovery document for HTTP MCP clients probing this origin. */
function mcpServerCard() {
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    protocolVersion: "2025-06-18",
    serverInfo: {
      name: "uploads-mcp",
      version: pkg.version,
      description:
        "Host files on uploads.sh from an agent — put, attach, list, delete, usage, and GitHub attachment comments.",
      homepage: "https://uploads.sh/",
    },
    transport: {
      type: "streamable-http",
      endpoint: "https://agents.uploads.sh/mcp",
    },
    capabilities: {
      tools: true,
      resources: false,
      prompts: false,
    },
    authentication: {
      required: true,
      schemes: ["bearer"],
      description:
        "Per-workspace bearer token (Authorization: Bearer up_<workspace>_…). Obtain via invitation + `uploads login`. See https://uploads.sh/auth.md",
    },
  };
}

const app = new Hono<WorkspaceVars>()
  .get("/health", (c) => c.json({ ok: true }))
  // Public discovery — registered before /:workspace/* so ".well-known" is not a tenant.
  .get("/.well-known/mcp/server-card.json", (c) => c.json(mcpServerCard()))
  // Primary endpoint: the workspace is inferred from the bearer token
  // (up_<workspace>_…), so clients only need the URL and the token.
  .post("/mcp", tokenWorkspaceAuth, handleMcp)
  .on(["GET", "DELETE"], "/mcp", methodNotAllowed)
  // Workspace-prefixed alternate, kept for existing clients.
  .use("/:workspace/*", workspaceAuth)
  .post("/:workspace/mcp", handleMcp)
  .on(["GET", "DELETE"], "/:workspace/mcp", methodNotAllowed)
  .onError((err, c) => respondError(c, err))
  .notFound((c) => respondError(c, new NotFoundError()));

export default app;
