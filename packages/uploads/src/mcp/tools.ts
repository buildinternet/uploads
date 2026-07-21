/**
 * MCP tool set mirroring the CLI commands (put, attach, list, delete,
 * usage, reconcile, purge_expired, comment, health, doctor). Config is
 * resolved fresh per tool call so a
 * per-call `workspace` argument behaves like the CLI's --workspace flag, and
 * a missing token surfaces as a tool error rather than a startup failure.
 */
import type { GlobalFlags } from "../cli-args.js";
import { createUploadsClient, type UploadsClient } from "../client.js";
import {
  buildDoctorReport,
  makeGhTarget,
  syncAttachmentsComment,
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
import { ghKeyPrefix, type GhTarget } from "../github.js";
import { safeCaptureFacts } from "../capture-facts.js";
import { validateMetaMap } from "../metadata.js";
import { mergeDerivedMeta } from "../metadata-vocab.js";
import { type OptimizeImageOptions } from "../optimize.js";
import {
  execRunner,
  ghMetadataFromTargetWithTitle,
  resolveCurrentPullRequest,
  resolveRepo,
  type CommandRunner,
} from "../github-gh.js";
import {
  appProp,
  canonicalMetaFromArgs,
  METADATA_DESCRIPTION,
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
import { batchFailureMessage, ToolBatchError, type McpTool } from "./server.js";
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
        "Upload one or more files to uploads.sh and get public URL(s) plus GitHub-ready embed markdown. Single-file: pass `file` or `contentBase64`+`filename` (flat result with `url`/`embedUrl`/`markdown`). Multi-file: pass `files` (paths; parallel; returns `uploads`+`failures`). Prefer `embedUrl` in PR/issue markdown. With `pr`/`issue` keys are stable and `comment` syncs the managed attachments comment. All uploads are public; pr/issue keys are predictable — upload only non-sensitive media.",
      inputSchema: {
        type: "object",
        properties: {
          file: {
            type: "string",
            description:
              "Path of a single file to upload. Exactly one of file, files, or contentBase64 is required.",
          },
          files: {
            type: "array",
            items: { type: "string" },
            description:
              "Paths of multiple files to upload in parallel. Returns { uploads, failures }. Cannot combine with file, contentBase64, key, or filename.",
          },
          contentBase64: {
            type: "string",
            description: "Base64-encoded file content for in-memory uploads; requires filename.",
          },
          filename: {
            type: "string",
            description:
              "Filename for contentBase64 content (drives the key and content type). With single `file`, overrides the key's leaf (clean name) while keeping the pr/default path.",
          },
          key: {
            type: "string",
            description:
              "Explicit object key (default: <prefix>/<repo>/<ref>/<name>-<hash>.<ext>). Single file only; cannot be combined with pr/issue.",
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
          comment: {
            type: "boolean",
            description:
              "With pr/issue: create or update the managed attachments comment. Posts as uploads-sh[bot] when the GitHub App is installed on the repo; otherwise via local gh auth (best-effort).",
          },
          dryRun: {
            type: "boolean",
            description:
              "Resolve key + public URL without uploading (also previews a strict-key refusal via wouldRefuse). Not with comment.",
          },
          replace: {
            type: "boolean",
            description:
              "Allow overwriting an existing object on a strict (non-gh/) key: explicit key, or the default put path. Default false — an existing object there is refused (key_exists) unless this is true or UPLOADS_OVERWRITE=1 is set in the server's environment. No effect on pr/issue keys, which always overwrite.",
          },
          metadata: metadataProp,
          state: stateProp,
          app: appProp,
          workspace: workspaceProp,
        },
        additionalProperties: false,
      },
      async handler(args) {
        const file = optString(args, "file");
        const filesArg = optStringArray(args, "files");
        const contentBase64 = optString(args, "contentBase64");
        if (filesArg !== undefined && filesArg.length === 0) {
          usage("files must be a non-empty array of paths");
        }
        const multi = filesArg !== undefined;
        const sources = [file !== undefined, multi, contentBase64 !== undefined];
        if (sources.filter(Boolean).length !== 1) {
          usage("exactly one of file, files, or contentBase64 is required");
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

        const { config, client } = clientFor(args);
        const defaults = resolvePutDefaults({ envFile: globals.envFile });
        const frameOpts = mcpFrameOptions(args);
        const optimizeOpts = mcpOptimizeOptions(args, defaults);
        const noGit = optBool(args, "noGit") || defaults.noGit === true;
        const alt = optString(args, "alt");
        const width = optPosInt(args, "width") ?? defaults.width;
        const contentType = optString(args, "contentType");
        const putShared = {
          client,
          ghTarget: target,
          prefix: resolvedPrefix ?? defaults.prefix,
          repo: optString(args, "repo") ?? defaults.repo,
          ref: refArg ?? defaults.ref,
          deriveRepoFromGit: !noGit,
          contentType,
          dryRun,
          replace: replaceArg,
          optimize: optimizeOpts,
          frame: frameOpts,
          metadata,
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
          if (wantComment && target && uploads.length > 0) {
            const { comment, commentError } = await syncComment(client, target, config.workspace);
            return { uploads, failures, comment, commentError };
          }
          return { uploads, failures };
        }

        // Single-file: contentBase64 still supported; paths go through uploadPuts.
        if (contentBase64 !== undefined) {
          const sourceName = filenameArg!;
          const bytes = new Uint8Array(Buffer.from(contentBase64, "base64"));
          const { result, prepared, markdown } = await uploadPreparedImage(
            client,
            bytes,
            sourceName,
            {
              frame: frameOpts,
              optimize: optimizeOpts,
              ghTarget: target,
              key: keyArg,
              prefix: resolvedPrefix ?? defaults.prefix,
              repo: optString(args, "repo") ?? defaults.repo,
              ref: refArg ?? defaults.ref,
              contentType,
              deriveRepoFromGit: !noGit,
              dryRun,
              replace: replaceArg,
              metadata,
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
          if (wantComment && target) {
            const { comment, commentError } = await syncComment(client, target, config.workspace);
            return { ...result, markdown, optimize, frame: prepared.frame, comment, commentError };
          }
          return {
            ...result,
            markdown,
            optimize,
            frame: prepared.frame,
            ...(dryRun ? { dryRun: true } : {}),
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
        };
        if (wantComment && target) {
          const { comment, commentError } = await syncComment(client, target, config.workspace);
          return { ...flat, comment, commentError };
        }
        return flat;
      },
    },
    {
      name: "screenshot",
      description:
        "Capture a URL or a local .html file and host it — a hosted, PR-embeddable image in one call. Backend `local` drives an already-installed Chrome/Chromium (dynamically loaded; unavailable in some runtimes); `remote` renders server-side via the workspace's render endpoint and counts against the monthly upload budget. Default via=auto prefers local when found, else remote. localhost/private-network URLs and .html files are local-only — via=remote (or auto falling back to remote) fails fast instead of a doomed request. Shares the put upload pipeline: optional frame, optimize-by-default, pr/issue attachment + comment, gallery, metadata. Uploads are public.",
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
          comment: {
            type: "boolean",
            description:
              "With pr/issue: create/update the managed attachments comment (best-effort).",
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

        const { config, client } = clientFor(args);
        const defaults = resolvePutDefaults({ envFile: globals.envFile });
        const frameOpts = mcpFrameOptions(args);
        const optimizeOpts = mcpOptimizeOptions(args, defaults);
        const noGit = optBool(args, "noGit") || defaults.noGit === true;
        const alt = optString(args, "alt");
        const width = optPosInt(args, "width") ?? defaults.width;

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
        const metadataWithCaptureFacts =
          metadata === undefined && Object.keys(captureDerived).length === 0
            ? undefined
            : mergeDerivedMeta(metadata ?? {}, captureDerived);
        let captured: Awaited<ReturnType<typeof screenshotModule.captureScreenshot>>;
        try {
          captured = await screenshotModule.captureScreenshot({
            target: targetArg!,
            via: viaArg,
            browserPath: optString(args, "browser"),
            cdp: optString(args, "cdp"),
            viewport,
            selector: optString(args, "selector"),
            fullPage: optBool(args, "fullPage"),
            colorScheme: colorSchemeArg as "dark" | "light" | undefined,
            waitUntil: screenshotModule.parseWaitUntil(optString(args, "wait")),
            hide: optStringArray(args, "hide"),
            hideDevTools: optBool(args, "noHideDevTools") ? false : undefined,
            reducedMotion: optBool(args, "reducedMotion"),
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

        const { result, prepared, markdown } = await uploadPreparedImage(
          client,
          captured.png,
          captured.filename,
          {
            frame: frameOpts,
            optimize: optimizeOpts,
            ghTarget: target,
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
        };
        if (wantComment && target) {
          const { comment, commentError } = await syncComment(client, target, config.workspace);
          return { ...flat, comment, commentError };
        }
        return flat;
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
          state: stateProp,
          app: appProp,
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
        const { config, client } = clientFor(args);
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
        "Create or update the managed attachments comment on a GitHub PR or issue, listing everything uploaded for it. Posts as uploads-sh[bot] when the GitHub App is installed on the repo; otherwise via local gh auth. Edits its own prior comment in place and never touches other comments.",
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
        const { config, client } = clientFor(args);
        const result = await syncAttachmentsComment(client, target, run, config.workspace);
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
