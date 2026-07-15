/**
 * MCP tool set mirroring the CLI commands (put, attach, list, delete,
 * usage, reconcile, purge_expired, comment, health, doctor). Config is
 * resolved fresh per tool call so a
 * per-call `workspace` argument behaves like the CLI's --workspace flag, and
 * a missing token surfaces as a tool error rather than a startup failure.
 */
import { basename } from "node:path";
import type { GlobalFlags } from "../cli-args.js";
import { createUploadsClient, type UploadsClient } from "../client.js";
import {
  buildDoctorReport,
  makeGhTarget,
  prepareImageForUpload,
  readFileArg,
  syncAttachmentsComment,
  uploadAttachments,
} from "../commands.js";
import { resolveFrameId } from "../frame.js";
import {
  resolveConfig,
  resolvePutDefaults,
  type ResolvedConfig,
  type UploadsClientConfig,
} from "../config.js";
import { buildMarkdown } from "../embed.js";
import { urlForGithubEmbed } from "../public-urls.js";
import { resolvePutPrefix } from "../destinations.js";
import { ghAttachmentKey, ghKeyPrefix, ghMetadataFromTarget, type GhTarget } from "../github.js";
import { validateMetaMap } from "../metadata.js";
import { rewriteKeyExtension, type OptimizeImageOptions } from "../optimize.js";
import { buildCliProvenance } from "../provenance.js";
import {
  execRunner,
  resolveCurrentPullRequest,
  resolveRepo,
  type CommandRunner,
} from "../github-gh.js";
import {
  METADATA_DESCRIPTION,
  metadataProp,
  optPosInt,
  optString,
  optStringArray,
  optStringRecord,
  usage,
  type ToolArgs,
} from "./args.js";
import type { McpTool } from "./server.js";
import {
  attachmentFromText,
  buildReportPayload,
  parseReportType,
  REPORT_TYPES,
  submitReport,
  validateReportMessage,
} from "../report.js";
import { resolveApiUrl } from "../config.js";

function optBool(args: ToolArgs, name: string): boolean {
  const v = args[name];
  if (v === undefined || v === null) return false;
  if (typeof v !== "boolean") usage(`${name} must be a boolean`);
  return v;
}

function mcpOptimizeOptions(
  args: ToolArgs,
  defaults: { noOptimize?: boolean; keepExif?: boolean },
): OptimizeImageOptions {
  const quality = optPosInt(args, "optimizeQuality");
  if (quality !== undefined && quality > 100) usage("optimizeQuality must be 1–100");
  return {
    enabled: !(optBool(args, "noOptimize") || defaults.noOptimize === true),
    maxEdge: optPosInt(args, "optimizeMaxEdge"),
    quality,
    keepExif: optBool(args, "keepExif") || defaults.keepExif === true,
  };
}

function mcpFrameOptions(args: ToolArgs): {
  frameId?: string;
  frameUrl?: string;
  frameFit?: "cover" | "contain";
} {
  const raw = optString(args, "frame");
  let frameId: string | undefined;
  try {
    frameId = resolveFrameId(raw);
  } catch (err) {
    usage(err instanceof Error ? err.message : String(err));
  }
  const fitRaw = optString(args, "frameFit");
  let frameFit: "cover" | "contain" | undefined;
  if (fitRaw) {
    if (fitRaw !== "cover" && fitRaw !== "contain") {
      usage("frameFit must be cover or contain");
    }
    frameFit = fitRaw;
  }
  if (frameFit && !frameId) usage("frameFit requires frame");
  const frameUrl = optString(args, "frameUrl");
  if (frameUrl && !frameId) usage("frameUrl requires frame");
  return { frameId, frameUrl, frameFit };
}

const frameProps = {
  frame: {
    type: "string",
    description: "Optional frame before optimize: phone | browser | iphone-16-pro.",
  },
  frameUrl: {
    type: "string",
    description: "Address bar text for frame=browser.",
  },
  frameFit: {
    type: "string",
    description: "cover (default) or contain.",
  },
};

/** Reads pr/issue (+ repo) into a GhTarget; undefined when neither is present. */
function ghTargetFromArgs(args: ToolArgs, run: CommandRunner): GhTarget | undefined {
  return makeGhTarget(
    optPosInt(args, "pr"),
    optPosInt(args, "issue"),
    optString(args, "repo"),
    run,
  );
}

function galleryId(args: ToolArgs): string {
  const id = optString(args, "galleryId");
  if (!id) usage("galleryId is required");
  return id;
}

function galleryReference(args: ToolArgs): { provider: "github"; coordinate: string } {
  const provider = optString(args, "provider");
  const coordinate = optString(args, "coordinate");
  if (!provider) usage("provider is required");
  if (!coordinate) usage("coordinate is required");
  if (provider !== "github") usage("provider must be github");
  return { provider, coordinate };
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
      name: "gallery_create",
      description:
        "Create a public ordered media gallery in the workspace. The returned canonical URL is safe to give users, but anyone who knows it can view the gallery and its media.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Gallery title (1–120 characters)." },
          description: { type: "string", description: "Optional public gallery description." },
          workspace: workspaceProp,
        },
        required: ["title"],
        additionalProperties: false,
      },
      async handler(args) {
        const title = optString(args, "title");
        if (!title) usage("title is required");
        const { client } = clientFor(args);
        return client.createGallery({ title, description: optString(args, "description") });
      },
    },
    {
      name: "gallery_get",
      description:
        "Get a workspace-owned gallery, including ordered media and its canonical public URL. Gallery media is public to anyone with the URL.",
      inputSchema: {
        type: "object",
        properties: {
          galleryId: { type: "string", description: "Opaque gallery ID." },
          workspace: workspaceProp,
        },
        required: ["galleryId"],
        additionalProperties: false,
      },
      async handler(args) {
        const { client } = clientFor(args);
        return client.getGallery(galleryId(args));
      },
    },
    {
      name: "gallery_add",
      description:
        "Add one existing, publicly served workspace object to a gallery. Reads the latest gallery version before writing, so the optimistic API version is handled safely. Does not upload or delete the object.",
      inputSchema: {
        type: "object",
        properties: {
          galleryId: { type: "string", description: "Opaque gallery ID." },
          objectKey: { type: "string", description: "Existing public object key to add." },
          caption: { type: "string", description: "Optional public caption." },
          altText: { type: "string", description: "Optional public alt text." },
          workspace: workspaceProp,
        },
        required: ["galleryId", "objectKey"],
        additionalProperties: false,
      },
      async handler(args) {
        const objectKey = optString(args, "objectKey");
        if (!objectKey) usage("objectKey is required");
        const { client } = clientFor(args);
        const id = galleryId(args);
        const current = await client.getGallery(id);
        return client.addGalleryItem(id, objectKey, {
          expectedVersion: current.version,
          caption: optString(args, "caption"),
          altText: optString(args, "altText"),
        });
      },
    },
    {
      name: "gallery_link",
      description:
        "Link a gallery to an external reference. References use provider-neutral fields; github currently accepts owner/repo#number or a strict GitHub issue/PR URL. No GitHub credentials or API calls are used.",
      inputSchema: {
        type: "object",
        properties: {
          galleryId: { type: "string", description: "Opaque gallery ID." },
          provider: { type: "string", description: "External provider (currently github)." },
          coordinate: {
            type: "string",
            description: "Provider-native external reference coordinate.",
          },
          workspace: workspaceProp,
        },
        required: ["galleryId", "provider", "coordinate"],
        additionalProperties: false,
      },
      async handler(args) {
        const { client } = clientFor(args);
        const id = galleryId(args);
        const current = await client.getGallery(id);
        return client.linkGalleryExternalReference(id, {
          expectedVersion: current.version,
          ...galleryReference(args),
        });
      },
    },
    {
      name: "gallery_find_by_reference",
      description:
        "Find workspace galleries linked to an external reference. Returns gallery summaries and canonical public URLs without contacting the provider.",
      inputSchema: {
        type: "object",
        properties: {
          provider: { type: "string", description: "External provider (currently github)." },
          coordinate: {
            type: "string",
            description: "Provider-native external reference coordinate.",
          },
          limit: { type: "number", description: "Page size (default 50, max 100)." },
          cursor: { type: "string", description: "Pagination cursor from a previous response." },
          workspace: workspaceProp,
        },
        required: ["provider", "coordinate"],
        additionalProperties: false,
      },
      async handler(args) {
        const { client } = clientFor(args);
        return client.findGalleriesByReference({
          ...galleryReference(args),
          limit: optPosInt(args, "limit"),
          cursor: optString(args, "cursor"),
        });
      },
    },
    {
      name: "put",
      description:
        "Upload a file to uploads.sh and get a public URL plus GitHub-ready embed markdown. Returns `url` (durable CDN) and `embedUrl` (same object, freshness-oriented host for GitHub Camo — prefer this in PR/issue markdown). The returned `markdown` already uses embedUrl when available. Pass `file` or `contentBase64` + `filename`; with `pr`/`issue` the key is stable and `comment` syncs the managed attachments comment. All uploads are public; pr/issue keys are predictable, so upload only non-sensitive media.",
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
            description:
              "Filename for contentBase64 content (drives the key and content type). With `file`, overrides the key's leaf (clean name) while keeping the pr/default path.",
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
          contentType: {
            type: "string",
            description: "Override the Content-Type (ignored when optimize rewrites the body).",
          },
          noOptimize: {
            type: "boolean",
            description:
              "Skip client-side image optimization (default: optimize still images to WebP).",
          },
          optimizeMaxEdge: {
            type: "number",
            description: "Max long edge in pixels when optimizing (default: 2400).",
          },
          optimizeQuality: {
            type: "number",
            description: "WebP quality 1–100 when optimizing (default: 85).",
          },
          keepExif: {
            type: "boolean",
            description:
              "Keep EXIF/XMP/ICC when optimizing (default: strip for privacy on public embeds).",
          },
          ...frameProps,
          noGit: { type: "boolean", description: "Don't derive the repo segment from git." },
          comment: {
            type: "boolean",
            description:
              "With pr/issue: create or update the managed attachments comment via local gh auth (best-effort).",
          },
          dryRun: {
            type: "boolean",
            description: "Resolve key + public URL without uploading. Not with comment.",
          },
          metadata: metadataProp,
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
        const dryRun = optBool(args, "dryRun");
        const keyArg = optString(args, "key");
        const destArg = optString(args, "destination");
        const prefixArg = optString(args, "prefix");
        const refArg = optString(args, "ref");
        if (wantComment && !target) usage("comment requires pr or issue");
        if (dryRun && wantComment) usage("dryRun cannot be combined with comment");
        if (target) {
          if (keyArg) usage("key cannot be combined with pr/issue");
          if (refArg) usage("ref cannot be combined with pr/issue");
          if (prefixArg) usage("prefix cannot be combined with pr/issue");
        }
        // Validate up front (fail fast, before reading/optimizing the file).
        // undefined leaves existing metadata untouched; an object (even {})
        // fully replaces it — see metadataProp's description.
        const metadata = optStringRecord(args, "metadata");
        if (metadata) validateMetaMap(metadata);
        let resolvedPrefix: string | undefined;
        try {
          resolvedPrefix = resolvePutPrefix({
            destination: destArg,
            prefix: prefixArg,
            key: keyArg,
            ghAttachment: Boolean(target),
          });
        } catch (err) {
          usage(err instanceof Error ? err.message : String(err));
        }

        const { client } = clientFor(args);
        const bytes =
          file !== undefined
            ? readFileArg(file)
            : new Uint8Array(Buffer.from(contentBase64!, "base64"));
        const sourceName = file !== undefined ? (filenameArg ?? basename(file)) : filenameArg!;

        const defaults = resolvePutDefaults({ envFile: globals.envFile });
        const frameOpts = mcpFrameOptions(args);
        const optimizeOpts = mcpOptimizeOptions(args, defaults);
        const prepared = await prepareImageForUpload(bytes, sourceName, {
          ...frameOpts,
          optimize: optimizeOpts,
        });
        const filename = prepared.filename;
        let key = target ? ghAttachmentKey(target, filename) : keyArg;
        if (key && prepared.optimized) key = rewriteKeyExtension(key, filename);
        const noGit = optBool(args, "noGit") || defaults.noGit === true;
        const result = await client.put(prepared.bytes, {
          filename,
          key,
          prefix: resolvedPrefix ?? defaults.prefix,
          repo: optString(args, "repo") ?? defaults.repo,
          ref: refArg ?? defaults.ref,
          contentType: prepared.optimized ? prepared.contentType : optString(args, "contentType"),
          deriveRepoFromGit: !noGit,
          dryRun,
          provenance: buildCliProvenance({
            sourceName,
            client: "uploads-mcp",
            optimized: prepared.optimized,
            frameId: prepared.frame?.framed ? prepared.frame.frameId : undefined,
            keepExif: optimizeOpts.keepExif === true,
          }),
          metadata,
        });
        const markdown = buildMarkdown(urlForGithubEmbed(result.url, result.embedUrl)!, {
          alt: optString(args, "alt") ?? sourceName,
          width: optPosInt(args, "width") ?? defaults.width,
        });
        const optimize = {
          optimized: prepared.optimized,
          skippedReason: prepared.skippedReason,
          originalBytes: prepared.originalBytes,
          outputBytes: prepared.outputBytes,
          filename: prepared.filename,
        };

        if (wantComment && target) {
          const { comment, commentError } = await syncComment(client, target);
          return { ...result, markdown, optimize, frame: prepared.frame, comment, commentError };
        }
        return {
          ...result,
          markdown,
          optimize,
          frame: prepared.frame,
          ...(dryRun ? { dryRun: true } : {}),
        };
      },
    },
    {
      name: "attach",
      description:
        "Upload one or more files as stable PR/issue attachments (in parallel) and maintain a managed GitHub comment. Returns `uploads` and `failures` (one bad file does not abort the batch). Each success has `url`, `embedUrl`, and `markdown` (prefer embedUrl for GitHub). With no pr/issue, targets the current branch PR. Attachments are public and keys are predictable; upload only non-sensitive media.",
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
            description:
              "Override the Content-Type (applied to every file; ignored when optimize rewrites).",
          },
          noOptimize: {
            type: "boolean",
            description:
              "Skip client-side image optimization (default: optimize still images to WebP).",
          },
          optimizeMaxEdge: {
            type: "number",
            description: "Max long edge in pixels when optimizing (default: 2400).",
          },
          optimizeQuality: {
            type: "number",
            description: "WebP quality 1–100 when optimizing (default: 85).",
          },
          keepExif: {
            type: "boolean",
            description:
              "Keep EXIF/XMP/ICC when optimizing (default: strip for privacy on public embeds).",
          },
          ...frameProps,
          metadata: {
            ...metadataProp,
            description:
              "Extra queryable metadata (key→value), merged with the automatic gh.repo/gh.kind/gh.number/gh.ref pairs — a gh.* pair here loses to the resolved target's own gh.* value. " +
              METADATA_DESCRIPTION,
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
        const defaults = resolvePutDefaults({ envFile: globals.envFile });
        const frameOpts = mcpFrameOptions(args);
        const optimizeOpts = mcpOptimizeOptions(args, defaults);
        // User-supplied extras first, then the resolved target's gh.* —
        // explicit target pairs always win over a same-named metadata extra
        // (mirrors runAttach in ../commands.js). Validate the merged map (not
        // just the extras) so the 24-key/8KB caps are enforced client-side —
        // extras alone might pass while extras + the 4 gh.* pairs exceed the
        // cap, which would otherwise only be caught server-side after upload.
        const metaExtras = optStringRecord(args, "metadata") ?? {};
        const metadata = { ...metaExtras, ...ghMetadataFromTarget(target) };
        if (Object.keys(metadata).length > 0) validateMetaMap(metadata);

        const { uploads, failures, firstError } = await uploadAttachments({
          client,
          target,
          files,
          contentType,
          optimize: optimizeOpts,
          frame: frameOpts,
          metadata,
          provenanceClient: "uploads-mcp",
        });

        // Total failure → tool error (isError) so agents notice.
        if (uploads.length === 0 && failures.length > 0) {
          throw firstError instanceof Error ? firstError : new Error(String(firstError));
        }

        if (optBool(args, "noComment")) return { target, uploads, failures };
        const { comment, commentError } = await syncComment(client, target);
        return { target, uploads, failures, comment, commentError };
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
      name: "get_metadata",
      description:
        "Read an object's queryable custom metadata (D1 key-value pairs, not R2 provenance). Returns `{ metadata }` (empty when none). Object must exist. Same as `uploads meta get`.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Object key to inspect." },
          workspace: workspaceProp,
        },
        required: ["key"],
        additionalProperties: false,
      },
      async handler(args) {
        const key = optString(args, "key");
        if (!key) usage("key is required");
        return clientFor(args).client.getMetadata(key);
      },
    },
    {
      name: "set_metadata",
      description:
        "Merge-set and/or delete an object's queryable custom metadata (D1 key-value pairs, not R2 provenance). `set` wins over `delete` for the same key. " +
        METADATA_DESCRIPTION +
        " Requires at least one of `set` or `delete`. Same as `uploads meta set`.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Object key to update." },
          set: { ...metadataProp, description: "Keys to set/overwrite. " + METADATA_DESCRIPTION },
          delete: {
            type: "array",
            items: { type: "string" },
            description: "Keys to remove.",
          },
          workspace: workspaceProp,
        },
        required: ["key"],
        additionalProperties: false,
      },
      async handler(args) {
        const key = optString(args, "key");
        if (!key) usage("key is required");
        const set = optStringRecord(args, "set");
        const del = optStringArray(args, "delete");
        if ((!set || Object.keys(set).length === 0) && (!del || del.length === 0)) {
          usage("set_metadata requires set and/or delete");
        }
        if (set) validateMetaMap(set);
        const { client } = clientFor(args);
        return client.patchMetadata(key, { set, delete: del });
      },
    },
    {
      name: "find_files",
      description:
        "Find objects in the workspace whose queryable custom metadata matches ALL of `filters` (ANDed equality). Returns each match's key, public URL, and full metadata map. Same as `uploads find k=v...` / `uploads list --meta k=v`.",
      inputSchema: {
        type: "object",
        properties: {
          filters: {
            ...metadataProp,
            description: "Metadata equality filters (at least one pair). " + METADATA_DESCRIPTION,
          },
          prefix: { type: "string", description: "Key prefix filter, combinable with filters." },
          limit: { type: "number", description: "Page size (default 50, max 500)." },
          workspace: workspaceProp,
        },
        required: ["filters"],
        additionalProperties: false,
      },
      async handler(args) {
        const filters = optStringRecord(args, "filters");
        if (!filters || Object.keys(filters).length === 0) {
          usage("filters must have at least one key");
        }
        validateMetaMap(filters);
        const { client } = clientFor(args);
        return client.findFiles(filters, {
          prefix: optString(args, "prefix"),
          limit: optPosInt(args, "limit"),
        });
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
    {
      name: "report",
      description:
        "Send an explicit diagnostic report to the uploads team (message + optional text log). " +
        "Only call this when the user asked to submit feedback, a bug report, or error logs — " +
        "never automatically. Do not include tokens, secrets, or private file contents. " +
        "Same as `uploads report`.",
      inputSchema: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "Short description of the problem (required, 5–4000 chars).",
          },
          type: {
            type: "string",
            description: `One of: ${REPORT_TYPES.join(", ")} (default: other).`,
          },
          contact: {
            type: "string",
            description: "Optional contact for follow-up (email or handle).",
          },
          command: {
            type: "string",
            description: "Command that failed (e.g. put) — name only, no paths or args.",
          },
          errorCode: {
            type: "string",
            description: "Optional UploadsError code (e.g. KEY_POLICY).",
          },
          attachmentText: {
            type: "string",
            description:
              "Optional text log/trace body the user consented to send (max 256 KiB). Not a file path.",
          },
          attachmentFilename: {
            type: "string",
            description: "Filename label for attachmentText (default: trace.txt).",
          },
        },
        required: ["message"],
        additionalProperties: false,
      },
      async handler(args) {
        const messageRaw = optString(args, "message");
        if (!messageRaw) usage("message is required");
        const validated = validateReportMessage(messageRaw);
        if (!validated.ok) usage(validated.error);

        const typeRaw = optString(args, "type");
        if (typeRaw && !parseReportType(typeRaw)) {
          usage(`type must be one of: ${REPORT_TYPES.join(", ")}`);
        }
        const type = parseReportType(typeRaw) ?? "other";

        let attachment;
        const attachmentText = optString(args, "attachmentText");
        if (attachmentText) {
          try {
            attachment = attachmentFromText(
              attachmentText,
              optString(args, "attachmentFilename") ?? "trace.txt",
            );
          } catch (err) {
            usage(err instanceof Error ? err.message : String(err));
          }
        }

        const payload = buildReportPayload(validated.message, {
          type,
          contact: optString(args, "contact"),
          surface: "mcp",
          command: optString(args, "command"),
          errorCode: optString(args, "errorCode"),
          attachment,
        });

        const apiUrl = resolveApiUrl(globals);
        const result = await submitReport(payload, { apiUrl });
        if (!result.ok) usage(`couldn't send report: ${result.error}`);
        return {
          ok: true,
          id: result.id,
          hasAttachment: result.hasAttachment,
        };
      },
    },
  ];
}
