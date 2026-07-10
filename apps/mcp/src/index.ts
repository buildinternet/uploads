/**
 * Remote MCP server for uploads.sh — a standalone worker on mcp.uploads.sh.
 *
 * Stateless MCP Streamable HTTP: each POST carries one JSON-RPC message and
 * gets its response (or 202 for notifications) in the same HTTP exchange. No
 * sessions and no SSE stream — spec-compliant for a stateless server, so
 * GET/DELETE on the endpoint are 405. Auth is the REST API's per-workspace
 * bearer-token middleware; the protocol core is the CLI package's
 * `createMcpServer`, shared verbatim.
 */
import { createMcpServer } from "@buildinternet/uploads/mcp";
import { workspaceAuth, type WorkspaceVars } from "@uploads/api/workspace";
import { Hono } from "hono";
import { createRemoteTools } from "./tools";

/** Kept in sync with package.json by hand — fine for a private worker. */
const SERVER_VERSION = "0.1.0";

const app = new Hono<WorkspaceVars>()
  .get("/health", (c) => c.json({ ok: true }))
  .use("/:workspace/*", workspaceAuth)
  .post("/:workspace/mcp", async (c) => {
    const body = await c.req.text();
    const server = createMcpServer({
      serverInfo: { name: "uploads-mcp", version: SERVER_VERSION },
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
  })
  .on(["GET", "DELETE"], "/:workspace/mcp", (c) => c.json({ error: "method not allowed" }, 405))
  .onError((err, c) => {
    console.error(JSON.stringify({ message: err.message, stack: err.stack }));
    return c.json({ error: "internal error" }, 500);
  })
  .notFound((c) => c.json({ error: "not found" }, 404));

export default app;
