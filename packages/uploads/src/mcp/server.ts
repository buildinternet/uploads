/**
 * Minimal, dependency-free MCP (Model Context Protocol) server core.
 *
 * Transport is one JSON-RPC 2.0 message per line/request. This module is
 * transport- and runtime-agnostic (usable from Workers as well as Node) —
 * `handleLine` takes a raw message string and returns the serialized response
 * (or undefined when no response is due), so it is directly testable. The
 * stdio transport lives in ./stdio.ts; logs must never go to stdout.
 */
import { UploadsError } from "../errors.js";
import { errorCodeFromUnknown, recordEvent } from "../telemetry.js";

export {
  METADATA_DESCRIPTION,
  metadataProp,
  optPosInt,
  optString,
  optStringArray,
  optStringRecord,
  usage,
  type ToolArgs,
} from "./args.js";

export interface McpTool {
  name: string;
  description: string;
  /** Hand-written JSON Schema for the tool's arguments. */
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface McpServer {
  /** Handle one JSON-RPC line. Undefined for notifications / client responses. */
  handleLine(line: string): Promise<string | undefined>;
}

const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);
const LATEST_PROTOCOL_VERSION = "2025-06-18";

type JsonRpcId = string | number | null;

function response(id: JsonRpcId, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function errorResponse(id: JsonRpcId, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

/** Tool failures become tool results (isError), never JSON-RPC errors. */
function toolErrorText(err: unknown): string {
  if (err instanceof UploadsError) return `${err.message} (${err.code})`;
  return err instanceof Error ? err.message : String(err);
}

export function createMcpServer(opts: {
  serverInfo: { name: string; version: string };
  tools: McpTool[];
}): McpServer {
  const { serverInfo, tools } = opts;

  async function callTool(id: JsonRpcId, params: Record<string, unknown>): Promise<string> {
    const name = params.name;
    const tool = typeof name === "string" ? tools.find((t) => t.name === name) : undefined;
    if (!tool) return errorResponse(id, -32602, `unknown tool: ${String(name ?? "(missing)")}`);
    const args = params.arguments ?? {};
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      return errorResponse(id, -32602, "tool arguments must be an object");
    }
    const start = Date.now();
    const command = `tool ${tool.name}`.slice(0, 120);
    try {
      const result = await tool.handler(args as Record<string, unknown>);
      void recordEvent({
        surface: "mcp",
        command,
        exitCode: 0,
        durationMs: Date.now() - start,
      });
      return response(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
        isError: false,
      });
    } catch (err) {
      void recordEvent({
        surface: "mcp",
        command,
        exitCode: 1,
        durationMs: Date.now() - start,
        errorCode: errorCodeFromUnknown(err),
      });
      return response(id, {
        content: [{ type: "text", text: toolErrorText(err) }],
        isError: true,
      });
    }
  }

  return {
    async handleLine(line) {
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        return errorResponse(null, -32700, "Parse error");
      }
      // JSON-RPC batching was removed from MCP: arrays are invalid requests.
      if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
        return errorResponse(null, -32600, "Invalid Request");
      }
      const record = msg as Record<string, unknown>;
      const { method, params } = record;
      // A response from the client (has result/error, no method): ignore.
      if (method === undefined && ("result" in record || "error" in record)) return undefined;
      const id: JsonRpcId =
        typeof record.id === "string" || typeof record.id === "number" ? record.id : null;
      if (typeof method !== "string") return errorResponse(id, -32600, "Invalid Request");
      if (method.startsWith("notifications/")) return undefined;
      // A request without an id is a notification — never respond.
      if (!("id" in record)) return undefined;

      const p = (
        typeof params === "object" && params !== null && !Array.isArray(params) ? params : {}
      ) as Record<string, unknown>;

      try {
        switch (method) {
          case "initialize": {
            const requested = typeof p.protocolVersion === "string" ? p.protocolVersion : "";
            const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested)
              ? requested
              : LATEST_PROTOCOL_VERSION;
            return response(id, { protocolVersion, capabilities: { tools: {} }, serverInfo });
          }
          case "ping":
            return response(id, {});
          case "tools/list":
            return response(id, {
              tools: tools.map(({ name, description, inputSchema }) => ({
                name,
                description,
                inputSchema,
              })),
            });
          case "tools/call":
            return await callTool(id, p);
          default:
            return errorResponse(id, -32601, `method not found: ${method}`);
        }
      } catch (err) {
        return errorResponse(id, -32603, err instanceof Error ? err.message : String(err));
      }
    },
  };
}
