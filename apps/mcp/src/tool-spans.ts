import type { McpTool } from "@buildinternet/uploads/mcp";
import { withSpan } from "@uploads/observability/tracing";

/**
 * Wraps each tool handler in a span named the way the OpenTelemetry MCP and
 * GenAI conventions name a tool call (`tools/call put`), so Cloudflare's
 * trace view shows which tool ran and the D1/R2/API spans under it. A throw
 * is recorded on the span, then reaches the server's own wrapper unchanged,
 * which still turns it into an `isError` tool result.
 *
 * Only the tool name is recorded, never its arguments.
 */
export function traceTools(tools: McpTool[]): McpTool[] {
  return tools.map((tool) => ({
    ...tool,
    handler: (args) =>
      withSpan(
        `tools/call ${tool.name}`,
        {
          "mcp.method.name": "tools/call",
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": tool.name,
        },
        async () => tool.handler(args),
      ),
  }));
}
