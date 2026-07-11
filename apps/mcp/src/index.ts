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
import { tokenWorkspaceAuth, workspaceAuth, type WorkspaceVars } from "@uploads/api/workspace";
import { Hono, type Context } from "hono";
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

const methodNotAllowed = (c: Context<WorkspaceVars>) =>
  c.json({ error: "method not allowed" }, 405);

const app = new Hono<WorkspaceVars>()
  .get("/health", (c) => c.json({ ok: true }))
  // Primary endpoint: the workspace is inferred from the bearer token
  // (up_<workspace>_…), so clients only need the URL and the token.
  .post("/mcp", tokenWorkspaceAuth, handleMcp)
  .on(["GET", "DELETE"], "/mcp", methodNotAllowed)
  // Workspace-prefixed alternate, kept for existing clients.
  .use("/:workspace/*", workspaceAuth)
  .post("/:workspace/mcp", handleMcp)
  .on(["GET", "DELETE"], "/:workspace/mcp", methodNotAllowed)
  .onError((err, c) => {
    console.error(JSON.stringify({ message: err.message, stack: err.stack }));
    return c.json({ error: "internal error" }, 500);
  })
  .notFound((c) => c.json({ error: "not found" }, 404));

export default app;
