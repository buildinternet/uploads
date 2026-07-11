/**
 * MCP tool set mirroring the CLI commands (put, attach, list, delete,
 * usage, reconcile, purge_expired, comment, health, doctor). Config is
 * resolved fresh per tool call so a
 * per-call `workspace` argument behaves like the CLI's --workspace flag, and
 * a missing token surfaces as a tool error rather than a startup failure.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { GlobalFlags } from "../cli-args.js";
import { createUploadsClient, type UploadsClient } from "../client.js";
import { buildDoctorReport, makeGhTarget, syncAttachmentsComment } from "../commands.js";
import {
  resolveConfig,
  resolvePutDefaults,
  type ResolvedConfig,
  type UploadsClientConfig,
} from "../config.js";
import { buildMarkdown } from "../embed.js";
import { resolvePutPrefix } from "../destinations.js";
import { ghAttachmentKey, ghKeyPrefix, type GhTarget } from "../github.js";
import {
  execRunner,
  resolveCurrentPullRequest,
  resolveRepo,
  type CommandRunner,
} from "../github-gh.js";
import { optPosInt, optString, usage, type ToolArgs } from "./args.js";
import type { McpTool } from "./server.js";

function optBool(args: ToolArgs, name: string): boolean {
  const v = args[name];
  if (v === undefined || v === null) return false;
  if (typeof v !== "boolean") usage(`${name} must be a boolean`);
  return v;
}

function optStringArray(args: ToolArgs, name: string): string[] | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((item) => typeof item !== "string")) {
    usage(`${name} must be an array of strings`);
  }
  return v as string[];
}

/** Reads pr/issue (+ repo) into a GhTarget; undefined when neither is present. */
function ghTargetFromArgs(args: ToolArgs, run: CommandRunner): GhTarget | undefined {
  return makeGhTarget(
    optPosInt(args, "pr"),
    optPosInt(args, "issue"),
    optString(args, "repo"),
    run,
  );
}

const workspaceProp = {
  type: "string",
  description: "Override the workspace for this call (like the CLI's --workspace flag).",
};

/** pr/issue/repo schema properties shared by the tools that resolve a GhTarget. */
function ghTargetProps(action: string) {
  return {
    pr: {
      type: "number",
      description: `${action} this pull request. Mutually exclusive with issue.`,
    },
    issue: {
      type: "number",
      description: `${action} this issue. Mutually exclusive with pr.`,
    },
    repo: {
      type: "string",
      description: "owner/name repository (default: gh/git inference).",
    },
  };
}

export function createUploadsMcpTools(opts: {
  globals: GlobalFlags;
  runner?: CommandRunner;
  clientFactory?: (config: UploadsClientConfig) => UploadsClient;
}): McpTool[] {
  const { globals } = opts;
  const run = opts.runner ?? execRunner;
  const clientFactory = opts.clientFactory ?? createUploadsClient;

  function clientFor(
    args: ToolArgs,
    requireToken = true,
  ): { config: ResolvedConfig; client: UploadsClient } {
    const config = resolveConfig({
      apiUrl: globals.apiUrl,
      token: globals.token,
      envFile: globals.envFile,
      workspace: optString(args, "workspace") ?? globals.workspace,
      requireToken,
    });
    return { config, client: clientFactory(config) };
  }

  const syncComment = async (client: UploadsClient, target: GhTarget) => {
    let comment: { action: "created" | "updated" | "skipped"; count: number } | undefined;
    let commentError: string | undefined;
    try {
      comment = await syncAttachmentsComment(client, target, run);
    } catch (err) {
      // Uploads already succeeded; the comment is best-effort by design.
      commentError = err instanceof Error ? err.message : String(err);
    }
    return { comment, commentError };
  };

  return [
    {
      name: "put",
      description:
        "Upload a file to uploads.sh and get a public URL plus GitHub-ready embed markdown (the returned `markdown` is ready to paste into a PR or issue). Pass `file` (a local path) or `contentBase64` + `filename` for in-memory content; with `pr`/`issue` the key is stable (same filename → same URL) and `comment` syncs the managed attachments comment.",
      inputSchema: {
        type: "object",
        properties: {
          file: {
            type: "string",
            description:
              "Path of the file to upload. Exactly one of file or contentBase64 is required.",
          },
          contentBase64: {
            type: "string",
            description: "Base64-encoded file content for in-memory uploads; requires filename.",
          },
          filename: {
            type: "string",
            description: "Filename for contentBase64 content (drives the key and content type).",
          },
          key: {
            type: "string",
            description:
              "Explicit object key (default: <prefix>/<repo>/<ref>/<name>-<hash>.<ext>). Cannot be combined with pr/issue.",
          },
          destination: {
            type: "string",
            description:
              "Typed destination root: screenshots | gh | f. Sets the key prefix; first-class alternative to prefix. With pr/issue must be gh or omitted.",
          },
          prefix: {
            type: "string",
            description:
              "Key prefix (default: screenshots, or UPLOADS_DEFAULT_PREFIX). Cannot be combined with pr/issue.",
          },
          ...ghTargetProps("Attach to"),
          // put's repo doubles as the default key layout's repo segment.
          repo: {
            type: "string",
            description: "owner/name repo segment (default: git remote, or UPLOADS_DEFAULT_REPO).",
          },
          ref: {
            type: "string",
            description:
              "PR/issue/branch key segment (default: today, or UPLOADS_DEFAULT_REF). Cannot be combined with pr/issue.",
          },
          alt: { type: "string", description: "Alt text for the markdown (default: filename)." },
          width: {
            type: "number",
            description: "Emit <img width=…> markdown instead of a plain image embed.",
          },
          contentType: { type: "string", description: "Override the Content-Type." },
          noGit: { type: "boolean", description: "Don't derive the repo segment from git." },
          comment: {
            type: "boolean",
            description:
              "With pr/issue: create or update the managed attachments comment via local gh auth (best-effort).",
          },
          workspace: workspaceProp,
        },
        additionalProperties: false,
      },
      async handler(args) {
        const file = optString(args, "file");
        const contentBase64 = optString(args, "contentBase64");
        if ((file === undefined) === (contentBase64 === undefined)) {
          usage("exactly one of file or contentBase64 is required");
        }
        const filenameArg = optString(args, "filename");
        if (contentBase64 !== undefined && !filenameArg) {
          usage("filename is required with contentBase64");
        }

        const target = ghTargetFromArgs(args, run);
        const wantComment = optBool(args, "comment");
        const key = optString(args, "key");
        const destArg = optString(args, "destination");
        const prefixArg = optString(args, "prefix");
        const refArg = optString(args, "ref");
        if (wantComment && !target) usage("comment requires pr or issue");
        if (target) {
          if (key) usage("key cannot be combined with pr/issue");
          if (refArg) usage("ref cannot be combined with pr/issue");
          if (prefixArg) usage("prefix cannot be combined with pr/issue");
        }
        let resolvedPrefix: string | undefined;
        try {
          resolvedPrefix = resolvePutPrefix({
            destination: destArg,
            prefix: prefixArg,
            key,
            ghAttachment: Boolean(target),
          });
        } catch (err) {
          usage(err instanceof Error ? err.message : String(err));
        }

        const { client } = clientFor(args);
        const bytes =
          file !== undefined
            ? new Uint8Array(readFileSync(file))
            : new Uint8Array(Buffer.from(contentBase64!, "base64"));
        const filename = file !== undefined ? (filenameArg ?? basename(file)) : filenameArg!;

        const defaults = resolvePutDefaults({ envFile: globals.envFile });
        const noGit = optBool(args, "noGit") || defaults.noGit === true;
        const result = await client.put(bytes, {
          filename,
          key: target ? ghAttachmentKey(target, filename) : key,
          prefix: resolvedPrefix ?? defaults.prefix,
          repo: optString(args, "repo") ?? defaults.repo,
          ref: refArg ?? defaults.ref,
          contentType: optString(args, "contentType"),
          deriveRepoFromGit: !noGit,
        });
        const markdown = buildMarkdown(result.url, {
          alt: optString(args, "alt") ?? filename,
          width: optPosInt(args, "width") ?? defaults.width,
        });

        if (wantComment && target) {
          const { comment, commentError } = await syncComment(client, target);
          return { ...result, markdown, comment, commentError };
        }
        return { ...result, markdown };
      },
    },
    {
      name: "attach",
      description:
        "Upload one or more files as stable PR/issue attachments and maintain a single managed GitHub comment listing them (each upload's `markdown` is ready to paste into GitHub). With no pr/issue, targets the pull request for the current branch.",
      inputSchema: {
        type: "object",
        properties: {
          files: {
            type: "array",
            items: { type: "string" },
            description: "Paths of the files to upload (at least one).",
          },
          ...ghTargetProps("Attach to"),
          noComment: {
            type: "boolean",
            description: "Upload only; don't create/update the managed comment.",
          },
          contentType: {
            type: "string",
            description: "Override the Content-Type (applied to every file).",
          },
          workspace: workspaceProp,
        },
        required: ["files"],
        additionalProperties: false,
      },
      async handler(args) {
        const files = optStringArray(args, "files");
        if (!files || files.length === 0) usage("files must be a non-empty array of paths");

        const explicitTarget = ghTargetFromArgs(args, run);
        const target =
          explicitTarget ??
          resolveCurrentPullRequest(resolveRepo(optString(args, "repo"), run), run);
        const { client } = clientFor(args);
        const contentType = optString(args, "contentType");

        const uploads = [];
        for (const file of files) {
          const filename = basename(file);
          const result = await client.put(new Uint8Array(readFileSync(file)), {
            filename,
            key: ghAttachmentKey(target, filename),
            contentType,
          });
          uploads.push({ ...result, markdown: buildMarkdown(result.url, { alt: filename }) });
        }

        if (optBool(args, "noComment")) return { target, uploads };
        const { comment, commentError } = await syncComment(client, target);
        return { target, uploads, comment, commentError };
      },
    },
    {
      name: "list",
      description:
        "List uploaded objects in the workspace, filtered by key prefix or by a PR/issue's attachments. Paginate with cursor, or set all to fetch every page.",
      inputSchema: {
        type: "object",
        properties: {
          prefix: {
            type: "string",
            description:
              "Key prefix filter (default: UPLOADS_DEFAULT_PREFIX + '/'). Cannot be combined with pr/issue.",
          },
          ...ghTargetProps("List attachments for"),
          limit: { type: "number", description: "Page size." },
          cursor: { type: "string", description: "Pagination cursor from a previous call." },
          all: { type: "boolean", description: "Follow cursors and return every page." },
          workspace: workspaceProp,
        },
        additionalProperties: false,
      },
      async handler(args) {
        const defaults = resolvePutDefaults({ envFile: globals.envFile });
        const prefixArg = optString(args, "prefix");
        let prefix = prefixArg ?? (defaults.prefix ? `${defaults.prefix}/` : undefined);
        const target = ghTargetFromArgs(args, run);
        if (target) {
          if (prefixArg) usage("prefix cannot be combined with pr/issue");
          prefix = ghKeyPrefix(target);
        }
        const limit = optPosInt(args, "limit");
        const cursor = optString(args, "cursor");
        const { client } = clientFor(args);

        if (optBool(args, "all")) {
          const items = await client.listAll({ prefix, limit, cursor });
          return { items, cursor: null };
        }
        return client.list({ prefix, limit, cursor });
      },
    },
    {
      name: "delete",
      description: "Delete an uploaded object by key. Set dryRun to preview without deleting.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Object key to delete." },
          dryRun: {
            type: "boolean",
            description: "Report what would be deleted without deleting.",
          },
          workspace: workspaceProp,
        },
        required: ["key"],
        additionalProperties: false,
      },
      async handler(args) {
        const key = optString(args, "key");
        if (!key) usage("key is required");
        if (optBool(args, "dryRun")) return { key, deleted: false, dryRun: true };
        const { client } = clientFor(args);
        return client.delete(key);
      },
    },
    {
      name: "usage",
      description:
        "Workspace storage and monthly upload counters (and remaining headroom when budgets are configured). Same as `uploads usage`.",
      inputSchema: {
        type: "object",
        properties: { workspace: workspaceProp },
        additionalProperties: false,
      },
      async handler(args) {
        const { client } = clientFor(args);
        return client.usage();
      },
    },
    {
      name: "reconcile",
      description:
        "Rebuild usage ledger bytes/objects from storage (source of truth). Preserves the monthly upload counter. Requires files:write. Same as `uploads reconcile`.",
      inputSchema: {
        type: "object",
        properties: { workspace: workspaceProp },
        additionalProperties: false,
      },
      async handler(args) {
        const { client } = clientFor(args);
        return client.reconcile();
      },
    },
    {
      name: "purge_expired",
      description:
        "Delete objects older than the workspace retentionDays setting, then reconcile. Skips if retention is unset. Requires files:delete. Same as `uploads purge-expired`.",
      inputSchema: {
        type: "object",
        properties: { workspace: workspaceProp },
        additionalProperties: false,
      },
      async handler(args) {
        const { client } = clientFor(args);
        return client.purgeExpired();
      },
    },
    {
      name: "comment",
      description:
        "Create or update the managed attachments comment on a GitHub PR or issue, listing everything uploaded for it. Uses local gh auth; edits its own prior comment in place and never touches other comments.",
      inputSchema: {
        type: "object",
        properties: {
          ...ghTargetProps("Comment on"),
          workspace: workspaceProp,
        },
        additionalProperties: false,
      },
      async handler(args) {
        const target = ghTargetFromArgs(args, run);
        if (!target) usage("comment requires pr or issue");
        const { client } = clientFor(args);
        const result = await syncAttachmentsComment(client, target, run);
        return { ...target, ...result };
      },
    },
    {
      name: "health",
      description: "Check uploads.sh API liveness. No auth or arguments required.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async handler(args) {
        const { config, client } = clientFor(args, false);
        const result = await client.health();
        return { ...result, apiUrl: config.apiUrl };
      },
    },
    {
      name: "doctor",
      description:
        "Diagnose the configuration: API health, token auth, and workspace/token alignment. Returns the same report as `uploads doctor --json`, including hints.",
      inputSchema: {
        type: "object",
        properties: { workspace: workspaceProp },
        additionalProperties: false,
      },
      async handler(args) {
        const { config, client } = clientFor(args);
        return buildDoctorReport(config, client);
      },
    },
  ];
}
