/**
 * Test plumbing for driving an `McpServer` on either wire era.
 *
 * The server core no longer exposes a JSON-RPC entry point of its own (the SDK
 * owns dispatch), so tests go through a transport the way a real client does:
 * `rpc` for 2026-07-28 traffic, `legacyRpc` for the 2025-era `initialize` flow.
 */
import {
  createMcpHandler,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import type { McpServer } from "../src/mcp/server.js";

/** Node-side validator; apps/mcp injects the workerd-safe one instead. */
export const validator = new AjvJsonSchemaValidator();

export const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
export const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
export const MODERN_PROTOCOL_VERSION = "2026-07-28";

/**
 * A 2026-07-28 POST: the per-request `_meta` envelope replaces the removed
 * `initialize` handshake, and SEP-2243 mirrors the method — plus the tool name
 * for `tools/call` — into `Mcp-Method` / `Mcp-Name` headers.
 */
export function modernRequest(method: string, params?: unknown, id: number | string = 1): Request {
  const p = (typeof params === "object" && params !== null ? params : {}) as Record<
    string,
    unknown
  >;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-method": method,
  };
  if (method === "tools/call" && typeof p.name === "string") headers["mcp-name"] = p.name;
  return new Request("https://uploads.test/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: {
        ...p,
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
          [CLIENT_CAPABILITIES_META_KEY]: {},
        },
      },
    }),
  });
}

/** A modern-era notification: same envelope, but no `id`, so no reply is due. */
export function modernNotification(method: string, params?: Record<string, unknown>): Request {
  return new Request("https://uploads.test/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-method": method,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method,
      params: {
        ...params,
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
          [CLIENT_CAPABILITIES_META_KEY]: {},
        },
      },
    }),
  });
}

/** Run an already-built request through the modern (2026-07-28) leg. */
export async function modernFetch(server: McpServer, request: Request): Promise<Response> {
  const handler = createMcpHandler(() => server, { legacy: "reject" });
  try {
    return await handler.fetch(request);
  } finally {
    // Closing the handler does not close the caller's server instance, so a
    // test can keep making calls against the same one.
    await handler.close();
  }
}

/** One modern-era JSON-RPC round trip. Undefined for a 202 (notification). */
export async function rpc(
  server: McpServer,
  method: string,
  params?: unknown,
  id: number | string = 1,
  // oxlint-disable-next-line no-explicit-any
): Promise<any> {
  const res = await modernFetch(server, modernRequest(method, params, id));
  const text = await res.text();
  return text === "" ? undefined : JSON.parse(text);
}

/**
 * One 2025-era round trip through the hand-wired legacy transport — the same
 * one apps/mcp uses, with `enableJsonResponse` so replies stay plain JSON
 * rather than the SSE the SDK's own legacy fallback would emit.
 */
export async function legacyFetch(server: McpServer, body: string): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return await transport.handleRequest(
    new Request("https://uploads.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body,
    }),
  );
}

export async function legacyRpc(
  server: McpServer,
  method: string,
  params?: unknown,
  id: number | string = 1,
  // oxlint-disable-next-line no-explicit-any
): Promise<any> {
  const res = await legacyFetch(server, JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  const text = await res.text();
  return text === "" ? undefined : JSON.parse(text);
}
