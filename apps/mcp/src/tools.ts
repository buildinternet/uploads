/**
 * Remote MCP tool set — the hosted subset of the CLI's stdio tools (put,
 * list, delete, health). Everything is scoped to the workspace resolved by
 * `workspaceAuth`; token scopes are enforced inside handlers, where a throw
 * becomes an isError tool result rather than a JSON-RPC error. Tools needing
 * a filesystem or the gh CLI (attach, comment, doctor) stay stdio-only.
 */
import { buildMarkdown, buildScreenshotKey, inferContentType } from "@buildinternet/uploads";
import type { McpTool } from "@buildinternet/uploads/mcp";
import { UPLOAD_CACHE_CONTROL, badKey } from "@uploads/api/files";
import { publicUrl, storage, storageConfig } from "@uploads/api/storage";
import type { WorkspaceRecord, WorkspaceVars } from "@uploads/api/workspace";

type FileScope = WorkspaceVars["Variables"]["authScopes"][number];

export interface RemoteToolContext {
  env: Env;
  workspace: WorkspaceRecord;
  workspaceName: string;
  authScopes: readonly FileScope[];
}

type ToolArgs = Record<string, unknown>;

function usage(msg: string): never {
  throw new Error(msg);
}

function optString(args: ToolArgs, name: string): string | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") usage(`${name} must be a string`);
  return v;
}

function optPosInt(args: ToolArgs, name: string): number | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    usage(`${name} must be a positive integer`);
  }
  return v;
}

function decodeBase64(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    usage("contentBase64 must be valid base64");
  }
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

export function createRemoteTools(ctx: RemoteToolContext): McpTool[] {
  const { env, workspace, workspaceName } = ctx;

  function requireScope(scope: FileScope): void {
    if (!ctx.authScopes.includes(scope)) usage(`forbidden: requires ${scope} scope`);
  }

  return [
    {
      name: "put",
      description:
        "Upload base64-encoded content to the workspace and get a public URL plus GitHub-ready embed markdown (the returned `markdown` is ready to paste into a PR or issue). The key defaults to <prefix>/<repo>/<ref>/<name>-<hash>.<ext>; pass `key` for an explicit path instead.",
      inputSchema: {
        type: "object",
        properties: {
          contentBase64: {
            type: "string",
            description: "Base64-encoded file content to upload (must be non-empty).",
          },
          filename: {
            type: "string",
            description: "Filename for the content (drives the key and content type).",
          },
          key: {
            type: "string",
            description:
              "Explicit object key (default: <prefix>/<repo>/<ref>/<name>-<hash>.<ext>). Cannot be combined with prefix/repo/ref.",
          },
          prefix: {
            type: "string",
            description: "Key prefix for the default key layout (default: screenshots).",
          },
          repo: {
            type: "string",
            description: "owner/name repo segment for the default key layout (default: misc).",
          },
          ref: {
            type: "string",
            description: "PR/issue/branch key segment for the default key layout (default: today).",
          },
          contentType: {
            type: "string",
            description: "Override the Content-Type (default: inferred from filename).",
          },
          alt: { type: "string", description: "Alt text for the markdown (default: filename)." },
          width: {
            type: "number",
            description: "Emit <img width=…> markdown instead of a plain image embed.",
          },
        },
        required: ["contentBase64", "filename"],
        additionalProperties: false,
      },
      async handler(args) {
        requireScope("files:write");
        const contentBase64 = optString(args, "contentBase64");
        const filename = optString(args, "filename");
        if (!contentBase64) usage("contentBase64 is required");
        if (!filename) usage("filename is required");

        const explicitKey = optString(args, "key");
        const prefix = optString(args, "prefix");
        const repo = optString(args, "repo");
        const ref = optString(args, "ref");
        if (explicitKey && (prefix ?? repo ?? ref) !== undefined) {
          usage("key cannot be combined with prefix/repo/ref");
        }

        const bytes = decodeBase64(contentBase64);
        if (bytes.length === 0) usage("empty content");

        let key: string;
        if (explicitKey !== undefined) {
          if (badKey(explicitKey)) usage("invalid key");
          key = explicitKey;
        } else {
          // deriveRepoFromGit: false — no git (or child_process) on a worker.
          key = await buildScreenshotKey({
            filename,
            fileBytes: bytes,
            prefix,
            repo,
            ref,
            deriveRepoFromGit: false,
          });
        }

        const contentType = optString(args, "contentType") ?? inferContentType(filename);
        await storage(env, workspace).upload(key, bytes, {
          contentType,
          cacheControl: UPLOAD_CACHE_CONTROL,
        });

        const url = publicUrl(storageConfig(env, workspace), key);
        const markdown =
          url === null
            ? undefined
            : buildMarkdown(url, {
                alt: optString(args, "alt") ?? filename,
                width: optPosInt(args, "width"),
              });
        return { workspace: workspaceName, key, url, size: bytes.length, contentType, markdown };
      },
    },
    {
      name: "list",
      description:
        "List uploaded objects in the workspace, optionally filtered by key prefix. Paginate with cursor; each item includes its public URL when the workspace has one.",
      inputSchema: {
        type: "object",
        properties: {
          prefix: { type: "string", description: "Key prefix filter." },
          limit: { type: "number", description: "Page size (default 100, max 1000)." },
          cursor: { type: "string", description: "Pagination cursor from a previous call." },
        },
        additionalProperties: false,
      },
      async handler(args) {
        requireScope("files:read");
        const prefix = optString(args, "prefix");
        const limit = Math.min(optPosInt(args, "limit") ?? 100, 1000);
        const cursor = optString(args, "cursor");
        const result = await storage(env, workspace).list({ prefix, limit, cursor });
        const cfg = storageConfig(env, workspace);
        return {
          items: result.items.map((item: { key: string }) => ({
            ...item,
            url: publicUrl(cfg, item.key),
          })),
          cursor: result.cursor ?? null,
        };
      },
    },
    {
      name: "delete",
      description: "Delete an uploaded object in the workspace by key.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Object key to delete." },
        },
        required: ["key"],
        additionalProperties: false,
      },
      async handler(args) {
        requireScope("files:delete");
        const key = optString(args, "key");
        if (!key) usage("key is required");
        if (badKey(key)) usage("invalid key");
        await storage(env, workspace).delete(key);
        return { key, deleted: true };
      },
    },
    {
      name: "health",
      description: "Check uploads.sh MCP server liveness. No scope required.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async handler() {
        return { ok: true };
      },
    },
  ];
}
