/**
 * Remote MCP tool set — the hosted subset of the CLI's stdio tools (put,
 * list, delete, health). Everything is scoped to the workspace resolved by
 * `workspaceAuth`; token scopes are enforced inside handlers, where a throw
 * becomes an isError tool result rather than a JSON-RPC error. Tools needing
 * a filesystem or the gh CLI (attach, comment, doctor) stay stdio-only.
 */
import { buildMarkdown, buildScreenshotKey } from "@buildinternet/uploads";
import { optPosInt, optString, usage, type McpTool } from "@buildinternet/uploads/mcp";
import { deleteObject, listObjects, putObject } from "@uploads/api/files";
import { allowWrite, resolveUploadPolicy } from "@uploads/api/guards";
import type { FileScope, WorkspaceRecord } from "@uploads/api/workspace";

export interface RemoteToolContext {
  env: Env;
  workspace: WorkspaceRecord;
  workspaceName: string;
  authScopes: readonly FileScope[];
}

function decodeBase64(value: string, maxBytes: number): Uint8Array {
  // Pre-decode size gate: base64 encodes 3 bytes per 4 chars, so a string
  // longer than this cannot decode to a within-limit payload. Rejecting here
  // avoids materializing an oversized body in isolate memory; putObject's
  // inspectUpload remains the authoritative post-decode check.
  if (value.length > Math.ceil(maxBytes / 3) * 4 + 4) {
    usage(`contentBase64 exceeds the workspace upload limit (${maxBytes} bytes)`);
  }
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
    // Authorization failure, not a usage error — no (USAGE) suffix in the tool result.
    if (!ctx.authScopes.includes(scope)) throw new Error(`forbidden: requires ${scope} scope`);
  }

  async function requireWriteBudget(): Promise<void> {
    // Mirrors the REST API's writeRateLimit middleware (guards.ts): plain
    // Error, not usage() — over-budget is not a caller mistake.
    if (!(await allowWrite(env, workspaceName))) throw new Error("rate limit exceeded");
  }

  return [
    {
      name: "put",
      description:
        "Upload base64-encoded content to the workspace and get a public URL plus GitHub-ready embed markdown (the returned `markdown` is ready to paste into a PR or issue). The key defaults to <prefix>/<repo>/<ref>/<name>-<hash>.<ext>; pass `key` for an explicit path instead. The stored content type is sniffed from the bytes and restricted to the workspace's allowlist (images plus mp4/webm by default).",
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
        await requireWriteBudget();
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

        const bytes = decodeBase64(contentBase64, resolveUploadPolicy(workspace).maxBytes);

        const key =
          explicitKey ??
          // deriveRepoFromGit: false — no git (or child_process) on a worker.
          (await buildScreenshotKey({
            filename,
            fileBytes: bytes,
            prefix,
            repo,
            ref,
            deriveRepoFromGit: false,
          }));

        // Key/body validation and the size/type guardrails live in putObject,
        // shared with the REST API — the stored content type is sniffed there.
        const result = await putObject(env, workspace, key, bytes);
        const markdown =
          result.url === null
            ? undefined
            : buildMarkdown(result.url, {
                alt: optString(args, "alt") ?? filename,
                width: optPosInt(args, "width"),
              });
        return { workspace: workspaceName, ...result, markdown };
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
        return listObjects(env, workspace, {
          prefix: optString(args, "prefix"),
          limit: optPosInt(args, "limit"),
          cursor: optString(args, "cursor"),
        });
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
        await requireWriteBudget();
        const key = optString(args, "key");
        if (!key) usage("key is required");
        return deleteObject(env, workspace, key);
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
