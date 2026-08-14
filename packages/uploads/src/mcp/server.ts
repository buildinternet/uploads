/**
 * MCP (Model Context Protocol) server core, built on the v2 TypeScript SDK
 * (`@modelcontextprotocol/server`), which speaks spec `2026-07-28` and the
 * 2025-era revisions side by side.
 *
 * Tools stay declarative: callers pass `McpTool[]` with hand-written JSON
 * Schema and this module registers them with the SDK. That keeps the two tool
 * sets (./tools.ts and apps/mcp/src/tools.ts) free of SDK imports and confines
 * the dependency to this file.
 *
 * Runtime-agnostic, so the JSON Schema validator is injected rather than
 * chosen here: the SDK bundles no provider in its root entry, and the two
 * available ones are not interchangeable — Ajv compiles schemas at runtime and
 * workerd rejects that, so Workers callers must pass the `@cfworker/json-schema`
 * provider. See `@modelcontextprotocol/server/validators/{ajv,cf-worker}`.
 *
 * The stdio transport comes from `@modelcontextprotocol/server/stdio`; logs
 * must never go to stdout.
 */
import {
  fromJsonSchema,
  McpServer,
  type CacheHint,
  type CallToolResult,
  type jsonSchemaValidator,
} from "@modelcontextprotocol/server";
import { UploadsError } from "../errors.js";
import { errorCodeFromUnknown, recordEvent } from "../telemetry.js";
import { ToolBatchError } from "./batch-error.js";

export {
  appProp,
  canonicalMetaFromArgs,
  METADATA_DESCRIPTION,
  metadataArgWithCanonical,
  metadataProp,
  stateProp,
  optBool,
  optPosInt,
  optString,
  optStringArray,
  optStringRecord,
  usage,
  type ToolArgs,
} from "./args.js";
export { ToolBatchError, batchFailureMessage } from "./batch-error.js";
export { mapBounded } from "../async.js";
export { McpServer, type jsonSchemaValidator };
export {
  commentResultSchema,
  deleteResultSchema,
  findFilesResultSchema,
  galleryFindResultSchema,
  galleryResultSchema,
  healthResultSchema,
  hostedOutputSchemas,
  listResultSchema,
  metadataFacetsResultSchema,
  metadataResultSchema,
  promoteToolResultSchema,
  purgeExpiredResultSchema,
  putResultSchema,
  reconcileResultSchema,
  repoLinkStatusResultSchema,
  stdioOutputSchemas,
  usageResultSchema,
  withOutputSchemas,
} from "./output-schemas.js";

/** MCP tool safety hints. Required so tools/list advertises them for review. */
export interface McpToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
}

/** Lookup / list / health. Does not change workspace or public state. */
export const mcpRead: McpToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};

/** Creates or updates a public object, gallery, or comment without deleting. */
export const mcpWritePublic: McpToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
};

/** Deletes or overwrites a public object or a public GitHub comment. */
export const mcpDestroyPublic: McpToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
};

/** Mutates first-party / internal state only (ledger, reports). */
export const mcpWriteInternal: McpToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
};

/**
 * Per-tool auth policy for ChatGPT / Codex plugin review. Advertised on
 * tools/list as `_meta.securitySchemes` (the SDK has no first-class field).
 */
export type McpSecurityScheme = { type: "noauth" } | { type: "oauth2"; scopes: string[] };

function oauth(scopes: string[]): McpSecurityScheme[] {
  return [{ type: "oauth2", scopes }];
}

export const mcpOAuthRead = oauth(["files:read"]);
export const mcpOAuthWrite = oauth(["files:write"]);
export const mcpOAuthDelete = oauth(["files:delete"]);
/** Authenticated, no particular file scope (hosted `health`). */
export const mcpOAuthAny = oauth([]);
/** Callable without a token (stdio `health`). */
export const mcpNoAuth: McpSecurityScheme[] = [{ type: "noauth" }];

/**
 * Thrown when a presented token is missing a required scope. wrapHandler
 * turns this into a tool error that carries `_meta["mcp/www_authenticate"]`
 * so ChatGPT can prompt a re-consent.
 */
export class McpAuthError extends Error {
  readonly challenge: string;
  constructor(message: string, challenge: string) {
    super(message);
    this.name = "McpAuthError";
    this.challenge = challenge;
  }
}

/** Build an insufficient_scope challenge pointing at this resource's metadata. */
export function insufficientScopeError(resourceMetadataUrl: string, scope: string): McpAuthError {
  return new McpAuthError(
    `forbidden: requires ${scope} scope`,
    `Bearer resource_metadata="${resourceMetadataUrl}", error="insufficient_scope", error_description="This tool requires the ${scope} scope"`,
  );
}

export interface McpTool {
  name: string;
  description: string;
  /** Short label for tools/list. Falls back to `name` when omitted. */
  title?: string;
  annotations: McpToolAnnotations;
  securitySchemes: McpSecurityScheme[];
  /** Hand-written JSON Schema for the tool's arguments. */
  inputSchema: Record<string, unknown>;
  /**
   * Hand-written JSON Schema for successful `structuredContent`. Required
   * whenever the handler returns structured data (OpenAI Scan Tools).
   */
  outputSchema?: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * The tool catalog is fixed for the lifetime of a deploy, so a generous
 * freshness hint is honest. `private` rather than `public` because the list is
 * behind auth and, on the hosted worker, filtered by the caller's token
 * scopes — a shared intermediary must never serve one caller's tool list to
 * another.
 */
const TOOLS_LIST_CACHE_HINT: CacheHint = { ttlMs: 3_600_000, cacheScope: "private" };

/** Tool failures become tool results (isError), never JSON-RPC errors. */
function toolErrorText(err: unknown): string {
  if (err instanceof UploadsError) return `${err.message} (${err.code})`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Wraps a tool handler so its outcome becomes a `CallToolResult` and every
 * call is recorded. A throw is reported to the client as an errored tool
 * result rather than a protocol error, which is what lets an agent read the
 * message and retry.
 */
function wrapHandler(tool: McpTool, apiUrl: string | undefined) {
  const command = `tool ${tool.name}`.slice(0, 120);
  return async (args: Record<string, unknown>): Promise<CallToolResult> => {
    const start = Date.now();
    try {
      const result = await tool.handler(args ?? {});
      recordEvent(
        { surface: "mcp", command, exitCode: 0, durationMs: Date.now() - start },
        { apiUrl },
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result as CallToolResult["structuredContent"],
        isError: false,
      };
    } catch (err) {
      recordEvent(
        {
          surface: "mcp",
          command,
          exitCode: 1,
          durationMs: Date.now() - start,
          errorCode: errorCodeFromUnknown(err),
        },
        { apiUrl },
      );
      // Multi-file total failure: keep structuredContent so agents see every
      // per-file error, not only the first message string.
      if (err instanceof ToolBatchError) {
        return {
          content: [{ type: "text", text: JSON.stringify(err.structuredContent, null, 2) }],
          structuredContent: err.structuredContent as CallToolResult["structuredContent"],
          isError: true,
        };
      }
      if (err instanceof McpAuthError) {
        return {
          content: [{ type: "text", text: err.message }],
          isError: true,
          _meta: { "mcp/www_authenticate": [err.challenge] },
        };
      }
      return { content: [{ type: "text", text: toolErrorText(err) }], isError: true };
    }
  };
}

export function createMcpServer(opts: {
  serverInfo: { name: string; version: string };
  tools: McpTool[];
  /** API base for telemetry (honors uploads --api-url). */
  apiUrl?: string;
  /**
   * Runtime's JSON Schema validator. Node callers pass the Ajv provider;
   * Workers callers must pass the `@cfworker/json-schema` one.
   */
  validator: jsonSchemaValidator;
}): McpServer {
  const { serverInfo, tools, apiUrl, validator } = opts;
  const server = new McpServer(serverInfo, {
    cacheHints: { "tools/list": TOOLS_LIST_CACHE_HINT },
  });
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        ...(tool.title ? { title: tool.title } : {}),
        description: tool.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>(tool.inputSchema, validator),
        ...(tool.outputSchema
          ? { outputSchema: fromJsonSchema<Record<string, unknown>>(tool.outputSchema, validator) }
          : {}),
        annotations: tool.annotations,
        _meta: { securitySchemes: tool.securitySchemes },
      },
      wrapHandler(tool, apiUrl),
    );
  }
  return server;
}
