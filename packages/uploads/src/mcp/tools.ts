/**
 * MCP tool set mirroring the CLI commands (put, attach, list, delete,
 * usage, reconcile, purge_expired, comment, whoami, doctor). Config is
 * resolved fresh per tool call so a
 * per-call `workspace` argument behaves like the CLI's --workspace flag, and
 * a missing token surfaces as a tool error rather than a startup failure.
 */
import type { GlobalFlags } from "../cli-args.js";
import { createUploadsClient, type UploadsClient } from "../client.js";
import {
  buildDoctorReport,
  ghListPrefixes,
  ghMergedList,
  makeGhTarget,
  mergeStagingMeta,
  resolveAutoPrTarget,
  resolveGhPrefixSafe,
  resolvePutNudgeContext,
  resolvePutStagingTarget,
  resolveStaged,
  syncAttachmentsComment,
  autoPrNoteText,
  putNudgeText,
  type AttachmentsCommentResult,
  uploadAttachments,
  uploadPreparedImage,
  uploadPuts,
} from "../commands.js";
import { resolveFrameId } from "../frame.js";
import {
  resolveConfig,
  resolvePutDefaults,
  type ResolvedConfig,
  type UploadsClientConfig,
} from "../config.js";
import { resolvePutPrefix } from "../destinations.js";
import { fetchUploadSource, resolveUploadFilename } from "../fetch-upload-source.js";
import { ghKeyPrefix, ghPrivateKeyPrefix, type GhTarget } from "../github.js";
import { safeCaptureFacts } from "../capture-facts.js";
import { deriveRepoSlugFromGit } from "../keys.js";
import { validateMetaMap } from "../metadata.js";
import { mergeDerivedMeta } from "../metadata-vocab.js";
import { type OptimizeImageOptions } from "../optimize.js";
import {
  execRunner,
  ghMetadataFromTargetWithTitle,
  resolveCurrentBranch,
  resolveCurrentPullRequest,
  resolveRepo,
  type CommandRunner,
} from "../github-gh.js";
import {
  appProp,
  canonicalMetaFromArgs,
  METADATA_PATH_CUE,
  metadataArgWithCanonical,
  metadataProp,
  optBool,
  optPosInt,
  optString,
  optStringArray,
  optStringRecord,
  stateProp,
  usage,
  type ToolArgs,
} from "./args.js";
import {
  batchFailureMessage,
  mcpDestroyPublic,
  mcpNoAuth,
  mcpOAuthAny,
  mcpOAuthDelete,
  mcpOAuthRead,
  mcpOAuthWrite,
  mcpRead,
  mcpWriteInternal,
  mcpWritePublic,
  stdioOutputSchemas,
  withOutputSchemas,
  ToolBatchError,
  type McpTool,
} from "./server.js";
import {
  attachmentFromText,
  buildReportPayload,
  parseReportType,
  REPORT_TYPES,
  submitReport,
  validateReportMessage,
} from "../report.js";
import { resolveApiUrl } from "../config.js";

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

  async function clientFor(
    args: ToolArgs,
    requireToken = true,
  ): Promise<{ config: ResolvedConfig; client: UploadsClient }> {
    const config = resolveConfig({
      apiUrl: globals.apiUrl,
      token: globals.token,
      envFile: globals.envFile,
      workspace: optString(args, "workspace") ?? globals.workspace,
      requireToken,
    });
    return { config, client: clientFactory(config) };
  }

  const syncComment = async (client: UploadsClient, target: GhTarget, workspace?: string) => {
    let comment: AttachmentsCommentResult | undefined;
    let commentError: string | undefined;
    try {
      comment = await syncAttachmentsComment(client, target, run, workspace);
    } catch (err) {
      // Uploads already succeeded; the comment is best-effort by design.
      commentError = err instanceof Error ? err.message : String(err);
    }
    return { comment, commentError };
  };

  const tools: McpTool[] = [
    {
      name: "gallery_create",
      title: "Create gallery",
      annotations: mcpWritePublic,
      securitySchemes: mcpOAuthWrite,
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
        const { client } = await clientFor(args);
        return client.createGallery({ title, description: optString(args, "description") });
      },
    },
    {
      name: "gallery_get",
      title: "Get gallery",
      annotations: mcpRead,
      securitySchemes: mcpOAuthRead,
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
        const { client } = await clientFor(args);
        return client.getGallery(galleryId(args));
      },
    },
    {
      name: "gallery_add",
      title: "Add gallery item",
      annotations: mcpWritePublic,
      securitySchemes: mcpOAuthWrite,
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
        const { client } = await clientFor(args);
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
      title: "Link gallery",
      annotations: mcpWritePublic,
      securitySchemes: mcpOAuthWrite,
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
        const { client } = await clientFor(args);
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
      title: "Find galleries",
      annotations: mcpRead,
      securitySchemes: mcpOAuthRead,
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
        const { client } = await clientFor(args);
        return client.findGalleriesByReference({
          ...galleryReference(args),
          limit: optPosInt(args, "limit"),
          cursor: optString(args, "cursor"),
        });
      },
    },
    {
      name: "put",
      title: "Upload file",
      annotations: mcpDestroyPublic,
      securitySchemes: mcpOAuthWrite,
      description:
        "Upload one or more files and get a public URL plus GitHub-ready markdown. Prefer `embedUrl` in GitHub markdown. Pass `contentUrl` for a public HTTPS file, or http://localhost on this machine, instead of a local path. With `pr`/`issue`, keys are stable and the managed comment is synced. All uploads are public.",
      inputSchema: {
        type: "object",
        properties: {
          file: {
            type: "string",
            description:
              "Path of a single file to upload. Exactly one of file, files, contentBase64, or contentUrl is required.",
          },
          files: {
            type: "array",
            items: { type: "string" },
            description:
              "Paths of multiple files to upload in parallel. Returns { uploads, failures }. Cannot combine with file, contentBase64, contentUrl, key, or filename.",
          },
          contentBase64: {
            type: "string",
            description: "Base64-encoded file content for in-memory uploads; requires filename.",
          },
          contentUrl: {
            type: "string",
            description:
              "URL to fetch and upload. Public HTTPS, or http://localhost / 127.0.0.1 / *.localhost on this machine. Filename is optional when the URL path has a leaf. Other private/internal hosts are rejected. Exactly one of file, files, contentBase64, or contentUrl.",
          },
          filename: {
            type: "string",
            description:
              "Filename for contentBase64/contentUrl (drives the key and content type). With single `file`, overrides the key's leaf (clean name) while keeping the pr/default path.",
          },
          key: {
            type: "string",
            description:
              "Override the object key. Single file only; cannot combine with `pr`/`issue`.",
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
          alt: {
            type: "string",
            description:
              "Alt text for the markdown (default: each file's name; with multiple files applies to all).",
          },
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
          noPr: {
            type: "boolean",
            description:
              "Skip auto-PR context (issue #700): without pr/issue/key/ref/prefix/destination, a call on a branch mapping to exactly one open PR otherwise behaves as if pr had been passed (stable key + managed comment sync when comment is set). Also opts out via UPLOADS_NO_AUTO_PR=1.",
          },
          comment: {
            type: "boolean",
            description:
              "With `pr`/`issue` (or an auto-detected PR): create or update the managed attachments comment. Best-effort.",
          },
          dryRun: {
            type: "boolean",
            description:
              "Resolve key + public URL without uploading (also previews a strict-key refusal via wouldRefuse). Not with comment.",
          },
          replace: {
            type: "boolean",
            description:
              "Overwrite an existing object on a non-`gh/` key. Default false (or true if UPLOADS_OVERWRITE=1). No effect on `pr`/`issue` keys, which always overwrite.",
          },
          metadata: metadataProp,
          state: stateProp,
          app: appProp,
          workspace: workspaceProp,
        },
        additionalProperties: false,
        examples: [
          { file: "./after.png", pr: 12, state: "after" },
          { file: "./after.png", branch: "feat/settings", state: "after" },
          { files: ["./before.png", "./after.png"], pr: 12 },
          {
            contentUrl: "https://cdn.example/settings-after.png",
            pr: 12,
            state: "after",
          },
        ],
      },
      async handler(args) {
        const file = optString(args, "file");
        const filesArg = optStringArray(args, "files");
        const contentBase64 = optString(args, "contentBase64");
        const contentUrl = optString(args, "contentUrl");
        if (filesArg !== undefined && filesArg.length === 0) {
          usage("files must be a non-empty array of paths");
        }
        const multi = filesArg !== undefined;
        const sources = [
          file !== undefined,
          multi,
          contentBase64 !== undefined,
          contentUrl !== undefined,
        ];
        if (sources.filter(Boolean).length !== 1) {
          usage("exactly one of file, files, contentBase64, or contentUrl is required");
        }

        const filenameArg = optString(args, "filename");
        if (contentBase64 !== undefined && !filenameArg) {
          usage("filename is required with contentBase64");
        }
        if (multi && filenameArg) usage("filename cannot be combined with files");
        if (multi && optString(args, "key")) usage("key cannot be combined with files");

        const target = ghTargetFromArgs(args, run);
        const wantComment = optBool(args, "comment");
        const dryRun = optBool(args, "dryRun");
        const keyArg = optString(args, "key");
        const destArg = optString(args, "destination");
        const prefixArg = optString(args, "prefix");
        const refArg = optString(args, "ref");
        // Strict-overwrite gate (issue #174): defaults false; a strict-path
        // put (explicit key or the default path) refuses an existing object
        // unless this is true or UPLOADS_OVERWRITE=1 is set for this process.
        // No effect on pr/issue keys — the server always overwrites those.
        const replaceArg = optBool(args, "replace") ?? process.env.UPLOADS_OVERWRITE === "1";
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
        const metadata = metadataArgWithCanonical(args);
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

        const { config, client } = await clientFor(args);
        const defaults = resolvePutDefaults({ envFile: globals.envFile });
        const frameOpts = mcpFrameOptions(args);
        const optimizeOpts = mcpOptimizeOptions(args, defaults);
        const noGit = optBool(args, "noGit") || defaults.noGit === true;
        const noAutoPr = optBool(args, "noPr") || defaults.noAutoPr === true;
        const alt = optString(args, "alt");
        const width = optPosInt(args, "width") ?? defaults.width;
        const contentType = optString(args, "contentType");

        // Auto-PR context (issue #700): local stdio MCP put mirrors the CLI
        // default — no pr/issue/key/ref/prefix/destination, not noGit/noPr,
        // on a branch that maps to exactly one open PR behaves as if `pr`
        // had been passed (stable key + managed comment sync) instead of
        // the #403 staging default below. Never throws — see
        // resolveAutoPrTarget.
        const autoPrTarget = target
          ? undefined
          : resolveAutoPrTarget({
              ghTarget: target,
              keyHint: keyArg,
              refArg,
              prefixArg,
              destinationArg: destArg,
              noGit,
              noAutoPr,
              repoArg: optString(args, "repo") ?? defaults.repo,
              run,
            });
        const effectiveTarget = target ?? autoPrTarget;

        // Bare-put branch staging (issue #403): local stdio MCP put mirrors
        // the CLI default — no pr/issue/key/ref/prefix/destination, not
        // noGit, on a non-default git branch stages to the branch prefix
        // (identical key/metadata to `attach --branch`) instead of the
        // dated layout. Never throws — see resolvePutStagingTarget.
        // effectiveTarget (explicit pr/issue OR the #700 auto-PR match)
        // wins over staging, same as it wins over the dated layout.
        const stagingTarget = resolvePutStagingTarget({
          ghTarget: effectiveTarget,
          keyHint: keyArg,
          refArg,
          prefixArg,
          destinationArg: destArg,
          noGit,
          repoArg: optString(args, "repo") ?? defaults.repo,
          run,
        });

        // Bare-put nudge context (issue #393/#700): only relevant when
        // neither auto-PR nor staging took over. Finished into a hint once
        // upload keys exist, below.
        const nudgeCtx =
          effectiveTarget || stagingTarget
            ? undefined
            : resolvePutNudgeContext({
                quiet: false,
                noNudge: defaults.noNudge === true,
                ghTarget: target,
                keyHint: keyArg,
                noGit,
                repoArg: optString(args, "repo") ?? defaults.repo,
                run,
              });
        const autoPrHint = autoPrTarget ? autoPrNoteText(autoPrTarget.num) : undefined;

        // Derived `repo` metadata (spec: 2026-08-11-screenshots-project-grouping-design.md).
        // Same derivation the CLI does; MCP always derives (no --no-auto), so
        // this is only suppressed by noGit. metadataProp's contract: omitting
        // `metadata` means "leave what's already stored for this key
        // untouched" — an object (even {}) triggers a full replace. So only
        // fold the derived repo into a defined object when the caller already
        // supplied metadata, or branch staging is building one below anyway
        // (mergeStagingMeta always returns a defined object); never
        // synthesize metadata on a bare re-upload just to add repo, or a
        // no-metadata put would silently wipe everything already stored.
        const repoSlug = !noGit ? deriveRepoSlugFromGit(run) : undefined;
        const metadataWithRepo =
          repoSlug !== undefined && (metadata !== undefined || stagingTarget !== undefined)
            ? mergeDerivedMeta(metadata ?? {}, { repo: repoSlug })
            : metadata;
        const putMetadata = stagingTarget
          ? mergeStagingMeta(metadataWithRepo, stagingTarget)
          : metadataWithRepo;

        const putShared = {
          client,
          ghTarget: effectiveTarget,
          ghBranchTarget: stagingTarget,
          prefix: resolvedPrefix ?? defaults.prefix,
          repo: optString(args, "repo") ?? defaults.repo,
          ref: refArg ?? defaults.ref,
          deriveRepoFromGit: !noGit,
          contentType,
          dryRun,
          replace: replaceArg,
          optimize: optimizeOpts,
          frame: frameOpts,
          metadata: putMetadata,
          // The shared metadata description promises uploads.sh derives these
          // "automatically where it can" — MCP has no --no-auto, so always on.
          deriveImageFacts: true,
          provenanceClient: "uploads-mcp" as const,
          alt,
          width,
        };

        // Multi-file path (paths only — no base64 batch).
        if (multi) {
          const { uploads, failures } = await uploadPuts({
            ...putShared,
            files: filesArg!,
          });
          if (uploads.length === 0 && failures.length > 0) {
            throw new ToolBatchError(batchFailureMessage(failures), { uploads, failures });
          }
          const hint =
            autoPrHint ??
            (nudgeCtx && uploads.length > 0
              ? putNudgeText(
                  nudgeCtx.branch,
                  nudgeCtx.pr,
                  uploads.map((u) => u.key),
                )
              : undefined);
          if (wantComment && effectiveTarget && uploads.length > 0) {
            const { comment, commentError } = await syncComment(
              client,
              effectiveTarget,
              config.workspace,
            );
            return { uploads, failures, comment, commentError, ...(hint ? { hint } : {}) };
          }
          return { uploads, failures, ...(hint ? { hint } : {}) };
        }

        // Single-file: contentBase64 / contentUrl; paths go through uploadPuts.
        if (contentBase64 !== undefined || contentUrl !== undefined) {
          let bytes: Uint8Array;
          let sourceName: string;
          if (contentUrl !== undefined) {
            try {
              sourceName = resolveUploadFilename(contentUrl, filenameArg, "contentUrl", {
                allowLoopback: true,
              });
            } catch (err) {
              usage(err instanceof Error ? err.message : String(err));
            }
            bytes = await fetchUploadSource(contentUrl, {
              label: "contentUrl",
              userAgent: "uploads.sh/mcp",
              allowLoopback: true,
            });
          } else {
            sourceName = filenameArg!;
            bytes = new Uint8Array(Buffer.from(contentBase64!, "base64"));
          }
          const { result, prepared, markdown } = await uploadPreparedImage(
            client,
            bytes,
            sourceName,
            {
              frame: frameOpts,
              optimize: optimizeOpts,
              ghTarget: effectiveTarget,
              ghBranchTarget: stagingTarget,
              key: keyArg,
              prefix: resolvedPrefix ?? defaults.prefix,
              repo: optString(args, "repo") ?? defaults.repo,
              ref: refArg ?? defaults.ref,
              contentType,
              deriveRepoFromGit: !noGit,
              dryRun,
              replace: replaceArg,
              metadata: putMetadata,
              provenanceClient: "uploads-mcp",
              alt: () => alt ?? sourceName,
              width,
            },
          );
          const optimize = {
            optimized: prepared.optimized,
            skippedReason: prepared.skippedReason,
            originalBytes: prepared.originalBytes,
            outputBytes: prepared.outputBytes,
            filename: prepared.filename,
          };
          const hint =
            autoPrHint ??
            (nudgeCtx ? putNudgeText(nudgeCtx.branch, nudgeCtx.pr, [result.key]) : undefined);
          if (wantComment && effectiveTarget) {
            const { comment, commentError } = await syncComment(
              client,
              effectiveTarget,
              config.workspace,
            );
            return {
              ...result,
              markdown,
              optimize,
              frame: prepared.frame,
              comment,
              commentError,
              ...(hint ? { hint } : {}),
            };
          }
          return {
            ...result,
            markdown,
            optimize,
            frame: prepared.frame,
            ...(dryRun ? { dryRun: true } : {}),
            ...(hint ? { hint } : {}),
          };
        }

        const { uploads, failures, firstError } = await uploadPuts({
          ...putShared,
          files: [file!],
          nameOverride: filenameArg,
          explicitKey: keyArg,
        });
        if (uploads.length === 0 && failures.length > 0) {
          throw firstError instanceof Error ? firstError : new Error(String(firstError));
        }
        const u = uploads[0]!;
        const hint =
          autoPrHint ??
          (nudgeCtx ? putNudgeText(nudgeCtx.branch, nudgeCtx.pr, [u.key]) : undefined);
        const flat = {
          workspace: u.workspace,
          key: u.key,
          url: u.url,
          embedUrl: u.embedUrl,
          size: u.size,
          contentType: u.contentType,
          replaced: u.replaced,
          wouldRefuse: u.wouldRefuse,
          markdown: u.markdown,
          optimize: u.optimize,
          frame: u.frame,
          ...(dryRun ? { dryRun: true } : {}),
          ...(hint ? { hint } : {}),
        };
        if (wantComment && effectiveTarget) {
          const { comment, commentError } = await syncComment(
            client,
            effectiveTarget,
            config.workspace,
          );
          return { ...flat, comment, commentError };
        }
        return flat;
      },
    },
    {
      name: "screenshot",
      title: "Capture screenshot",
      annotations: mcpDestroyPublic,
      securitySchemes: mcpOAuthWrite,
      description:
        "Capture a URL or local HTML file and host it. Shares put's attach, comment, and metadata options. `via=local` needs Chrome; `via=remote` renders server-side. localhost URLs are local-only.",
      inputSchema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description: "http(s) URL, or a path to a local .html file.",
          },
          via: {
            type: "string",
            description: "Capture backend: auto (default) | local | remote.",
          },
          browser: {
            type: "string",
            description: "Explicit local browser executable path (local backend only).",
          },
          cdp: {
            type: "string",
            description:
              "Attach to a running Chrome via CDP instead of launching one (local backend only).",
          },
          viewport: {
            type: "string",
            description: "WIDTHxHEIGHT[@SCALEx], e.g. 1280x800@2x (default: 1280x800@2).",
          },
          selector: { type: "string", description: "Capture one element instead of the viewport." },
          fullPage: { type: "boolean", description: "Capture the full scrollable page." },
          maxHeight: {
            type: "number",
            description:
              "Cap on full-page capture height in CSS px (default: 5000, 0 = uncapped). A page over " +
              "the cap is clipped, with a `hint` in the result. Requires fullPage. Applied on both " +
              "via: local and via: remote so behavior matches.",
          },
          colorScheme: {
            type: "string",
            description:
              "Emulate prefers-color-scheme: dark | light. Full media-query emulation requires via: \"local\" — the remote backend only sets the CSS color-scheme property and won't flip a page's own prefers-color-scheme queries.",
          },
          wait: {
            type: "string",
            description:
              'Settle strategy: load (default) | domcontentloaded | networkidle | a millisecond count (millisecond counts are local-only — via: "local").',
          },
          hide: {
            type: "array",
            items: { type: "string" },
            description:
              "CSS selectors to hide (display:none) before capture. Works on both backends.",
          },
          noHideDevTools: {
            type: "boolean",
            description:
              "Don't auto-hide framework dev toolbars (Astro/Next/Nuxt/Vite), which are hidden by default for localhost/private-network targets.",
          },
          reducedMotion: {
            type: "boolean",
            description:
              'Emulate prefers-reduced-motion: reduce so animations settle. Best-effort on via: "remote" (neutralizes animations via injected CSS).',
          },
          key: {
            type: "string",
            description:
              "Explicit object key (default: <prefix>/<repo>/<ref>/<name>-<hash>.png). Cannot be combined with pr/issue.",
          },
          destination: {
            type: "string",
            description:
              "Typed destination root: screenshots | gh | f. With pr/issue must be gh or omitted.",
          },
          prefix: {
            type: "string",
            description: "Key prefix (default: screenshots, or UPLOADS_DEFAULT_PREFIX).",
          },
          ...ghTargetProps("Attach to"),
          repo: {
            type: "string",
            description: "owner/name repo segment (default: git remote, or UPLOADS_DEFAULT_REPO).",
          },
          ref: {
            type: "string",
            description: "PR/issue/branch key segment (default: today, or UPLOADS_DEFAULT_REF).",
          },
          alt: {
            type: "string",
            description: "Alt text for the markdown (default: derived filename).",
          },
          width: {
            type: "number",
            description: "Emit <img width=…> markdown instead of a plain embed.",
          },
          noOptimize: {
            type: "boolean",
            description: "Skip client-side image optimization (default: optimize to WebP).",
          },
          optimizeMaxEdge: {
            type: "number",
            description: "Max long edge in pixels when optimizing.",
          },
          optimizeQuality: { type: "number", description: "WebP quality 1-100 when optimizing." },
          keepExif: { type: "boolean", description: "Keep EXIF/XMP/ICC when optimizing." },
          ...frameProps,
          noGit: { type: "boolean", description: "Don't derive the repo segment from git." },
          noPr: {
            type: "boolean",
            description:
              "Skip auto-PR context (issue #700): without pr/issue/key/ref/prefix/destination, a call on a branch mapping to exactly one open PR otherwise behaves as if pr had been passed. Also opts out via UPLOADS_NO_AUTO_PR=1.",
          },
          comment: {
            type: "boolean",
            description:
              "With pr/issue (or auto-detected PR context): create/update the managed attachments comment (best-effort).",
          },
          galleryId: {
            type: "string",
            description: "Add the uploaded object to this public gallery.",
          },
          dryRun: {
            type: "boolean",
            description:
              "Capture + resolve key/URL without uploading. Not with comment or galleryId.",
          },
          metadata: metadataProp,
          state: stateProp,
          app: appProp,
          workspace: workspaceProp,
        },
        required: ["target"],
        additionalProperties: false,
        examples: [
          { target: "http://localhost:4321/settings", pr: 12, state: "after" },
          { target: "http://localhost:4321/settings", fullPage: true, state: "empty" },
        ],
      },
      async handler(args) {
        const targetArg = optString(args, "target");
        if (!targetArg) usage("target is required");
        const viaArg = optString(args, "via") ?? "auto";
        if (viaArg !== "auto" && viaArg !== "local" && viaArg !== "remote") {
          usage("via must be auto, local, or remote");
        }
        const colorSchemeArg = optString(args, "colorScheme");
        if (colorSchemeArg && colorSchemeArg !== "dark" && colorSchemeArg !== "light") {
          usage("colorScheme must be dark or light");
        }
        const fullPageArg = optBool(args, "fullPage");
        // Unlike other px args, 0 is valid here (uncapped) — optPosInt's
        // allowZero option covers it.
        const maxHeightArg = optPosInt(args, "maxHeight", { allowZero: true });
        if (maxHeightArg !== undefined && !fullPageArg) usage("maxHeight requires fullPage");

        const target = ghTargetFromArgs(args, run);
        const wantComment = optBool(args, "comment");
        const dryRun = optBool(args, "dryRun");
        const keyArg = optString(args, "key");
        const destArg = optString(args, "destination");
        const prefixArg = optString(args, "prefix");
        const refArg = optString(args, "ref");
        const galleryIdArg = optString(args, "galleryId");
        if (wantComment && !target) usage("comment requires pr or issue");
        if (dryRun && wantComment) usage("dryRun cannot be combined with comment");
        if (dryRun && galleryIdArg) usage("dryRun cannot be combined with galleryId");
        if (target) {
          if (keyArg) usage("key cannot be combined with pr/issue");
          if (refArg) usage("ref cannot be combined with pr/issue");
          if (prefixArg) usage("prefix cannot be combined with pr/issue");
        }
        const metadata = metadataArgWithCanonical(args);
        if (metadata) validateMetaMap(metadata);

        const { config, client } = await clientFor(args);
        const defaults = resolvePutDefaults({ envFile: globals.envFile });
        const frameOpts = mcpFrameOptions(args);
        const optimizeOpts = mcpOptimizeOptions(args, defaults);
        const noGit = optBool(args, "noGit") || defaults.noGit === true;
        const noAutoPr = optBool(args, "noPr") || defaults.noAutoPr === true;
        const alt = optString(args, "alt");
        const width = optPosInt(args, "width") ?? defaults.width;

        // Auto-PR context (issue #700): mirrors the CLI screenshot command
        // and the put tool above — no pr/issue/key/ref/prefix/destination,
        // not noGit/noPr, on a branch that maps to exactly one open PR
        // behaves as if `pr` had been passed (stable key + managed comment
        // sync) instead of the #469 auto-staging default below. Never
        // throws — see resolveAutoPrTarget.
        const autoPrTarget = target
          ? undefined
          : resolveAutoPrTarget({
              ghTarget: target,
              keyHint: keyArg,
              refArg,
              prefixArg,
              destinationArg: destArg,
              noGit,
              noAutoPr,
              repoArg: optString(args, "repo") ?? defaults.repo,
              run,
            });
        const effectiveTarget = target ?? autoPrTarget;

        // Auto branch staging (issue #469 lever 1): mirrors the CLI screenshot
        // command and the put tool above (issue #403) — no pr/issue/key/ref/
        // prefix/destination, not noGit, on a non-default git branch stages
        // to the branch prefix (identical key/metadata to `attach --branch`)
        // instead of the dated `screenshots/<repo>/<date>/...` layout. Never
        // throws — see resolvePutStagingTarget. effectiveTarget (explicit
        // pr/issue OR the #700 auto-PR match) wins over staging.
        const stagingTarget = resolvePutStagingTarget({
          ghTarget: effectiveTarget,
          keyHint: keyArg,
          refArg,
          prefixArg,
          destinationArg: destArg,
          noGit,
          repoArg: optString(args, "repo") ?? defaults.repo,
          run,
        });

        // Bare-screenshot nudge context (issue #393/#700): only relevant
        // when neither auto-PR nor staging took over.
        const nudgeCtx =
          effectiveTarget || stagingTarget
            ? undefined
            : resolvePutNudgeContext({
                quiet: false,
                noNudge: defaults.noNudge === true,
                ghTarget: target,
                keyHint: keyArg,
                noGit,
                repoArg: optString(args, "repo") ?? defaults.repo,
                run,
              });
        const autoPrHint = autoPrTarget ? autoPrNoteText(autoPrTarget.num) : undefined;

        let resolvedPrefix: string | undefined;
        try {
          resolvedPrefix = resolvePutPrefix({
            destination: destArg,
            prefix: prefixArg,
            key: keyArg,
            ghAttachment: Boolean(effectiveTarget) || stagingTarget !== undefined,
          });
        } catch (err) {
          usage(err instanceof Error ? err.message : String(err));
        }

        // Dynamic import only: keeps mcp/tools.ts (and therefore anything
        // that statically imports it) free of a static reference to the
        // local-backend chain. If this fails, the runtime can't do Node-side
        // capture at all — point the caller at the remote backend instead.
        let screenshotModule: typeof import("../screenshot.js");
        try {
          screenshotModule = await import("../screenshot.js");
        } catch (err) {
          usage(
            `screenshot capture is unavailable in this runtime; try via: "remote" instead (${
              err instanceof Error ? err.message : String(err)
            })`,
          );
        }

        const viewport = screenshotModule.parseViewport(optString(args, "viewport"));
        // Same derivation the CLI does — explicit args win over capture facts.
        // Keep undefined when nothing at all was supplied or derived, so the
        // "omit to leave stored metadata untouched" contract still holds.
        const captureDerived = safeCaptureFacts(
          targetArg!,
          viewport,
          colorSchemeArg as "dark" | "light" | undefined,
        );
        // Derived `repo` metadata (spec: 2026-08-11-screenshots-project-grouping-design.md).
        // Same derivation the CLI does, suppressed by noGit.
        const repoSlug = !noGit ? deriveRepoSlugFromGit(run) : undefined;
        const captureDerivedWithRepo = repoSlug
          ? { ...captureDerived, repo: repoSlug }
          : captureDerived;
        const metadataBase =
          metadata === undefined && Object.keys(captureDerivedWithRepo).length === 0
            ? undefined
            : mergeDerivedMeta(metadata ?? {}, captureDerivedWithRepo);
        // gh.* metadata: explicit pr/issue target wins; staging wins the same
        // way (matches attach --branch/bare put); otherwise capture-derived +
        // explicit only.
        const metadataWithCaptureFacts = stagingTarget
          ? mergeStagingMeta(metadataBase, stagingTarget)
          : metadataBase;
        let captured: Awaited<ReturnType<typeof screenshotModule.captureScreenshot>>;
        try {
          captured = await screenshotModule.captureScreenshot({
            target: targetArg!,
            via: viaArg,
            browserPath: optString(args, "browser"),
            cdp: optString(args, "cdp"),
            viewport,
            selector: optString(args, "selector"),
            fullPage: fullPageArg,
            maxHeight: maxHeightArg,
            colorScheme: colorSchemeArg as "dark" | "light" | undefined,
            waitUntil: screenshotModule.parseWaitUntil(optString(args, "wait")),
            hide: optStringArray(args, "hide"),
            hideDevTools: optBool(args, "noHideDevTools") ? false : undefined,
            reducedMotion: optBool(args, "reducedMotion"),
            // Skip folding when an explicit key was given — key sets the
            // whole object key, so there's no auto-derived name to fold
            // state into.
            state: keyArg ? undefined : metadataWithCaptureFacts?.state,
            apiUrl: config.apiUrl,
            token: config.token,
          });
        } catch (err) {
          if (
            err instanceof Error &&
            "code" in err &&
            (err as { code?: string }).code === "BROWSER_NOT_FOUND" &&
            viaArg === "local"
          ) {
            usage(`${err.message} — try via: "remote" instead`);
          }
          throw err;
        }

        // Resolved once (issue #631), only now that upload is actually
        // about to happen — never per file (screenshot uploads exactly one).
        const ghPrefix = effectiveTarget
          ? await resolveGhPrefixSafe(client, {
              repo: effectiveTarget.repo,
              target: { kind: effectiveTarget.kind, num: effectiveTarget.num },
            })
          : stagingTarget
            ? await resolveGhPrefixSafe(client, {
                repo: stagingTarget.repo,
                branch: stagingTarget.branch,
              })
            : undefined;

        const { result, prepared, markdown } = await uploadPreparedImage(
          client,
          captured.png,
          captured.filename,
          {
            frame: frameOpts,
            optimize: optimizeOpts,
            ghTarget: effectiveTarget,
            ghBranchTarget: stagingTarget,
            ghPrefix,
            key: keyArg,
            prefix: resolvedPrefix ?? defaults.prefix,
            repo: optString(args, "repo") ?? defaults.repo,
            ref: refArg ?? defaults.ref,
            deriveRepoFromGit: !noGit,
            dryRun,
            metadata: metadataWithCaptureFacts,
            deriveImageFacts: true,
            provenanceClient: "uploads-mcp-screenshot",
            alt: (p) => alt ?? p.filename,
            width,
          },
        );

        let gallery: { id: string; url?: string; error?: string } | undefined;
        if (galleryIdArg) {
          try {
            const current = await client.getGallery(galleryIdArg);
            await client.addGalleryItem(galleryIdArg, result.key, {
              expectedVersion: current.version,
              altText: alt ?? prepared.filename,
            });
            gallery = { id: galleryIdArg, url: current.url };
          } catch (err) {
            gallery = {
              id: galleryIdArg,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }

        const flat = {
          ...result,
          markdown,
          backend: captured.backend,
          optimize: {
            optimized: prepared.optimized,
            skippedReason: prepared.skippedReason,
            originalBytes: prepared.originalBytes,
            outputBytes: prepared.outputBytes,
            filename: prepared.filename,
          },
          frame: prepared.frame,
          gallery,
          ...(dryRun ? { dryRun: true } : {}),
          // Hint precedence (mirrors the CLI): the full-page height cap note
          // (issue #652) is about the just-captured image itself, more
          // immediately actionable than the #700 auto-PR/nudge notes below.
          ...(captured.capped?.clipped
            ? { hint: screenshotModule.clipHintText(captured.capped.maxHeightPx, "maxHeight") }
            : autoPrHint
              ? { hint: autoPrHint }
              : nudgeCtx
                ? { hint: putNudgeText(nudgeCtx.branch, nudgeCtx.pr, [result.key]) }
                : {}),
        };
        if (wantComment && effectiveTarget) {
          const { comment, commentError } = await syncComment(
            client,
            effectiveTarget,
            config.workspace,
          );
          return { ...flat, comment, commentError };
        }
        return flat;
      },
    },
    {
      name: "attach",
      title: "Attach to GitHub",
      annotations: mcpDestroyPublic,
      securitySchemes: mcpOAuthWrite,
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
          metadata: metadataProp,
          state: stateProp,
          app: appProp,
          workspace: workspaceProp,
        },
        required: ["files"],
        additionalProperties: false,
        examples: [
          { files: ["./after.png"], pr: 12, state: "after" },
          { files: ["./before.png", "./after.png"], pr: 12 },
        ],
      },
      async handler(args) {
        const files = optStringArray(args, "files");
        if (!files || files.length === 0) usage("files must be a non-empty array of paths");

        const explicitTarget = ghTargetFromArgs(args, run);
        const target =
          explicitTarget ??
          resolveCurrentPullRequest(resolveRepo(optString(args, "repo"), run), run);
        const { config, client } = await clientFor(args);
        const contentType = optString(args, "contentType");
        const defaults = resolvePutDefaults({ envFile: globals.envFile });
        const frameOpts = mcpFrameOptions(args);
        const optimizeOpts = mcpOptimizeOptions(args, defaults);
        // User-supplied extras first, then the resolved target's gh.* —
        // explicit target pairs always win over a same-named metadata extra
        // (mirrors runAttach in ../commands.js). Validate the merged map (not
        // just the extras) so the 24-key/8KB caps are enforced client-side —
        // extras alone might pass while extras + the gh.* pairs exceed the
        // cap, which would otherwise only be caught server-side after upload.
        const metaExtras = {
          ...optStringRecord(args, "metadata"),
          ...canonicalMetaFromArgs(args),
        };
        const metadata = { ...metaExtras, ...ghMetadataFromTargetWithTitle(target, run) };
        if (Object.keys(metadata).length > 0) validateMetaMap(metadata);

        const { uploads, failures } = await uploadAttachments({
          client,
          target,
          files,
          contentType,
          optimize: optimizeOpts,
          frame: frameOpts,
          metadata,
          provenanceClient: "uploads-mcp",
        });

        // Total failure → isError with full failures[] for agents.
        if (uploads.length === 0 && failures.length > 0) {
          throw new ToolBatchError(batchFailureMessage(failures), {
            target,
            uploads,
            failures,
          });
        }

        if (optBool(args, "noComment")) return { target, uploads, failures };
        const { comment, commentError } = await syncComment(client, target, config.workspace);
        return { target, uploads, failures, comment, commentError };
      },
    },
    {
      name: "list",
      title: "List files",
      annotations: mcpRead,
      securitySchemes: mcpOAuthRead,
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
        const { client } = await clientFor(args);
        // Also list every active private prefix, if any (issue #631) —
        // mirrors syncAttachmentsComment's gh-fallback gather: a repo's
        // attachment history can be split across the plain shape and
        // MULTIPLE private prefixes, not just the currently-resolved one.
        // `prefixes` stays undefined outside pr/issue (unchanged behavior);
        // collapses to `[prefix]` in plain mode, so the single-request path
        // below is byte-identical to pre-#631.
        let prefixes: string[] | undefined;
        if (target) {
          if (prefixArg) usage("prefix cannot be combined with pr/issue");
          prefix = ghKeyPrefix(target);
          const ghPrefix = await resolveGhPrefixSafe(client, {
            repo: target.repo,
            target: { kind: target.kind, num: target.num },
          });
          prefixes = ghListPrefixes(prefix, ghPrefix, (id) => ghPrivateKeyPrefix(id, target));
        }
        const limit = optPosInt(args, "limit");
        const cursor = optString(args, "cursor");

        if (optBool(args, "all")) {
          const items =
            prefixes && prefixes.length > 1
              ? await ghMergedList(prefixes, cursor, (p, c) =>
                  client.listAll({ prefix: p, limit, cursor: c }),
                )
              : await client.listAll({ prefix, limit, cursor });
          return { items, cursor: null };
        }
        if (prefixes && prefixes.length > 1) {
          const items = await ghMergedList(
            prefixes,
            cursor,
            async (p, c) => (await client.list({ prefix: p, limit, cursor: c })).items,
          );
          return { items, cursor: null };
        }
        return client.list({ prefix, limit, cursor });
      },
    },
    {
      name: "staged",
      title: "List staged files",
      annotations: mcpRead,
      securitySchemes: mcpOAuthRead,
      description:
        "List files staged for a git branch and whether they will auto-attach when a PR opens. Returns `{ repo, branch, files, binding }`.",
      inputSchema: {
        type: "object",
        properties: {
          branch: {
            type: "string",
            description: "Branch name (default: current git branch, worktree-safe).",
          },
          repo: {
            type: "string",
            description: "owner/name repo (default: gh/git remote inference).",
          },
          workspace: workspaceProp,
        },
        additionalProperties: false,
      },
      async handler(args) {
        const { client } = await clientFor(args);
        const repo = resolveRepo(optString(args, "repo"), run);
        const branch = optString(args, "branch") ?? resolveCurrentBranch(run);
        return resolveStaged({ client, repo, branch });
      },
    },
    {
      name: "delete",
      title: "Delete file",
      annotations: mcpDestroyPublic,
      securitySchemes: mcpOAuthDelete,
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
        const { client } = await clientFor(args);
        return client.delete(key);
      },
    },
    {
      name: "get_metadata",
      title: "Get metadata",
      annotations: mcpRead,
      securitySchemes: mcpOAuthRead,
      description:
        "Read the queryable tags on one file. Returns `{ metadata }` (empty when none). Same as `uploads meta get`.",
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
        return (await clientFor(args)).client.getMetadata(key);
      },
    },
    {
      name: "set_metadata",
      title: "Set metadata",
      annotations: mcpWritePublic,
      securitySchemes: mcpOAuthWrite,
      description:
        "Set or delete queryable tags on an existing file. `set` wins over `delete` for the same key. Requires `set` and/or `delete`. Same as `uploads meta set`.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Object key to update." },
          set: {
            ...metadataProp,
            description: "Keys to set or overwrite. " + METADATA_PATH_CUE,
          },
          delete: {
            type: "array",
            items: { type: "string" },
            description: "Keys to remove.",
          },
          workspace: workspaceProp,
        },
        required: ["key"],
        additionalProperties: false,
        examples: [{ key: "screenshots/settings.png", set: { path: "/settings", state: "after" } }],
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
        const { client } = await clientFor(args);
        return client.patchMetadata(key, { set, delete: del });
      },
    },
    {
      name: "find_files",
      title: "Find files",
      annotations: mcpRead,
      securitySchemes: mcpOAuthRead,
      description:
        "Search files by metadata (`filters`) and/or filename substring (`name`). At least one is required. Same as `uploads find`.",
      inputSchema: {
        type: "object",
        properties: {
          filters: {
            ...metadataProp,
            description:
              "Equality filters; all must match. " +
              METADATA_PATH_CUE +
              " Optional when `name` is set.",
          },
          name: {
            type: "string",
            description:
              "Case-insensitive substring match on object keys (1–128 chars). Optional when `filters` is non-empty.",
          },
          prefix: {
            type: "string",
            description: "Key prefix filter, combinable with filters/name.",
          },
          limit: { type: "number", description: "Page size (default 50, max 500)." },
          cursor: {
            type: "string",
            description:
              "Opaque continuation from a previous call's `cursor`. Pass it back unchanged with the same filters/name to get the next page; a null `cursor` means there are no more pages.",
          },
          all: {
            type: "boolean",
            description:
              "Follow the cursor and return every page, up to a bounded number of requests. A non-null `cursor` in the result means that bound was reached before the end — pass it back to continue.",
          },
          workspace: workspaceProp,
        },
        additionalProperties: false,
        examples: [{ filters: { path: "/settings", state: "after" } }, { name: "hero.png" }],
      },
      async handler(args) {
        const filters = optStringRecord(args, "filters") ?? {};
        const name = optString(args, "name");
        const hasMeta = Object.keys(filters).length > 0;
        if (!hasMeta && !name) {
          usage("find_files requires filters and/or name");
        }
        if (hasMeta) validateMetaMap(filters);
        const { client } = await clientFor(args);
        const opts = {
          name,
          prefix: optString(args, "prefix"),
          limit: optPosInt(args, "limit"),
          cursor: optString(args, "cursor"),
        };
        // `all` drains through findFilesAll, which caps its own page count —
        // unlike `list`'s `all`, this never runs unbounded.
        return optBool(args, "all")
          ? client.findFilesAll(filters, opts)
          : client.findFiles(filters, opts);
      },
    },
    {
      name: "list_metadata_keys",
      title: "List metadata keys",
      annotations: mcpRead,
      securitySchemes: mcpOAuthRead,
      description:
        "List metadata keys in the workspace (with counts). Pass `key` to list that key's values instead. Use before `find_files`. Same as `uploads meta keys`.",
      inputSchema: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description:
              "When set, return distinct values for this metadata key (with counts) instead of the key list.",
          },
          workspace: workspaceProp,
        },
        additionalProperties: false,
      },
      async handler(args) {
        const { client } = await clientFor(args);
        const key = optString(args, "key");
        return key ? client.listMetadataValues(key) : client.listMetadataKeys();
      },
    },
    {
      name: "usage",
      title: "Show usage",
      annotations: mcpRead,
      securitySchemes: mcpOAuthRead,
      description:
        "Workspace storage and monthly upload counters (and remaining headroom when budgets are configured). Same as `uploads usage`.",
      inputSchema: {
        type: "object",
        properties: { workspace: workspaceProp },
        additionalProperties: false,
      },
      async handler(args) {
        const { client } = await clientFor(args);
        return client.usage();
      },
    },
    {
      name: "reconcile",
      title: "Reconcile usage",
      annotations: mcpWriteInternal,
      securitySchemes: mcpOAuthWrite,
      description:
        "Rebuild usage ledger bytes/objects from storage (source of truth). Preserves the monthly upload counter. Requires files:write. Same as `uploads reconcile`.",
      inputSchema: {
        type: "object",
        properties: { workspace: workspaceProp },
        additionalProperties: false,
      },
      async handler(args) {
        const { client } = await clientFor(args);
        return client.reconcile();
      },
    },
    {
      name: "purge_expired",
      title: "Purge expired files",
      annotations: mcpDestroyPublic,
      securitySchemes: mcpOAuthDelete,
      description:
        "Delete objects older than the workspace retentionDays setting, then reconcile. Skips if retention is unset. Requires files:delete. Same as `uploads purge-expired`.",
      inputSchema: {
        type: "object",
        properties: { workspace: workspaceProp },
        additionalProperties: false,
      },
      async handler(args) {
        const { client } = await clientFor(args);
        return client.purgeExpired();
      },
    },
    {
      name: "comment",
      title: "Sync attachments comment",
      annotations: mcpDestroyPublic,
      securitySchemes: mcpOAuthWrite,
      description:
        "Create or update the managed attachments comment on a GitHub PR or issue, listing everything uploaded for it. Posts as uploads-sh[bot] when the GitHub App is installed on the repo; otherwise via local gh auth. Edits its own prior comment in place and never touches other comments.",
      inputSchema: {
        type: "object",
        properties: {
          ...ghTargetProps("Comment on"),
          workspace: workspaceProp,
        },
        additionalProperties: false,
        examples: [{ pr: 12 }],
      },
      async handler(args) {
        const target = ghTargetFromArgs(args, run);
        if (!target) usage("comment requires pr or issue");
        const { config, client } = await clientFor(args);
        // Explicit resync, same as `uploads comment` (issue #480).
        const result = await syncAttachmentsComment(client, target, run, config.workspace, {
          resync: true,
        });
        return { ...target, ...result };
      },
    },
    {
      name: "whoami",
      title: "Who am I",
      annotations: mcpRead,
      securitySchemes: mcpNoAuth,
      description:
        "Show the active uploads.sh identity: workspace, API URL, and token scopes. Use this to learn which workspace you're talking to. A successful result also means the API is up. For a full setup diagnosis, use `doctor`.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async handler(args) {
        const { config, client } = await clientFor(args, false);
        const health = await client.health();
        const signedIn = Boolean(config.token);
        let scopes: string[] | undefined;
        if (signedIn) {
          try {
            scopes = (await client.usage()).scopes;
          } catch {
            // Workspace and API URL are still useful if usage is unavailable.
          }
        }
        return {
          ok: health.ok,
          signedIn,
          workspace: config.workspace,
          apiUrl: config.apiUrl,
          ...(scopes ? { scopes } : {}),
        };
      },
    },
    {
      name: "doctor",
      title: "Diagnose setup",
      annotations: mcpRead,
      securitySchemes: mcpOAuthAny,
      description:
        "Diagnose the configuration: API health, token auth, and workspace/token alignment. Returns the same report as `uploads doctor --json`, including hints.",
      inputSchema: {
        type: "object",
        properties: { workspace: workspaceProp },
        additionalProperties: false,
      },
      async handler(args) {
        const { config, client } = await clientFor(args);
        return buildDoctorReport(config, client);
      },
    },
    {
      name: "report",
      title: "Send diagnostic report",
      annotations: mcpWriteInternal,
      securitySchemes: mcpOAuthWrite,
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
  return withOutputSchemas(tools, stdioOutputSchemas, { required: false });
}
